// /api/retainer/intake-upsert.js
// Upsert Customer, upload signature & docs to Shopify Files, write retainer/* metafields.
// Household/Vehicles saved as pretty lists (not JSON). No signature in checkout props.

const SHOP   = process.env.SHOPIFY_SHOP;        // e.g. my-store.myshopify.com
const ADMIN  = process.env.SHOPIFY_ADMIN_TOKEN; // Admin API access token
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);

// --- CORS ---
function cors(res, origin){
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary','Origin');
  }
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

// --- GraphQL helper ---
async function gql(query, variables){
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    const msg = j.errors ? JSON.stringify(j.errors) : await r.text();
    throw new Error(`GraphQL ${r.status}: ${msg}`);
  }
  return j.data;
}

const Q = {
  customersByEmail: `query($q:String!){ customers(first:1, query:$q){ nodes{ id email state } } }`,
  customerCreate:   `mutation($input:CustomerInput!){
    customerCreate(input:$input){ customer{ id email state } userErrors{ field message } }
  }`,
  customerUpdate:   `mutation($input:CustomerInput!){
    customerUpdate(input:$input){ customer{ id email state } userErrors{ field message } }
  }`,
  metafieldsSet:    `mutation($metafields:[MetafieldsSetInput!]!){
    metafieldsSet(metafields:$metafields){ metafields{ namespace key type } userErrors{ field message } }
  }`,
  stagedUploadsCreate: `mutation($input:[StagedUploadInput!]!){
    stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } }
  }`,
  fileCreate: `mutation($files:[FileCreateInput!]!){
    fileCreate(files:$files){ files{ id alt url } userErrors{ field message } }
  }`,
};

// --- validators ---
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').toLowerCase());
const isPhone = s => /^\+?[1-9]\d{7,14}$/.test(s||'');
const isYMD   = s => /^\d{4}-\d{2}-\d{2}$/.test(s||'');
const nonBlank = s => typeof s === 'string' ? s.trim() !== '' : s != null;

// --- dataURL -> Shopify Files ---
async function uploadDataUrlToFiles(dataUrl, alt='Upload'){
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    return { fileId:null, fileUrl:null, error:'invalid data url' };
  }
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/^data:([^;]+)/)||[])[1] || 'application/octet-stream';
  const buf  = Buffer.from(b64, 'base64');

  // 1) staged upload target
  const su = await gql(Q.stagedUploadsCreate, {
    input: [{ resource:'FILE', filename:`upload-${Date.now()}`, mimeType:mime, httpMethod:'POST' }]
  });
  const target = su.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url) return { fileId:null, fileUrl:null, error:'staged upload target missing' };

  // 2) send binary
  const form = new FormData();
  target.parameters.forEach(p=> form.append(p.name, p.value));
  form.append('file', new Blob([buf], { type:mime }), 'upload');
  const up = await fetch(target.url, { method:'POST', body: form });
  if (!up.ok) {
    const t = await up.text().catch(()=> '');
    return { fileId:null, fileUrl:null, error:`staged upload ${up.status}: ${t}` };
  }

  // 3) create file record
  const fc = await gql(Q.fileCreate, {
    files: [{ contentType: mime.startsWith('image/') ? 'IMAGE' : 'FILE', originalSource: target.resourceUrl, alt }]
  });
  const f = fc.fileCreate?.files?.[0];
  if (!f?.id) return { fileId:null, fileUrl:null, error:'fileCreate failed' };
  return { fileId: f.id, fileUrl: f.url || null, error: null };
}

// --- classic invite (optional) ---
async function sendInviteREST(customerGid, email){
  try{
    const id = String(customerGid).split('/').pop();
    const url = `https://${SHOP}/admin/api/2024-07/customers/${id}/send_invite.json`;
    const r = await fetch(url, {
      method:'POST',
      headers:{ 'X-Shopify-Access-Token': ADMIN, 'Content-Type':'application/json' },
      body: JSON.stringify({ customer_invite: { to: email || undefined } })
    });
    if (!r.ok) console.warn('invite failed', r.status, await r.text().catch(()=>'')); 
  }catch(e){ console.warn('invite error', e); }
}

// --- handler ---
export default async function handler(req, res){
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).end();

  try{
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'invalid or missing email' });

    // 1) find or create customer
    let id, state;
    try{
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
      id = found.customers.nodes[0]?.id;
      state = found.customers.nodes[0]?.state;
    }catch(e){
      if (String(e).includes('ACCESS_DENIED')) {
        return res.status(200).json({ ok:false, error:'App lacks Protected customer data. Approve scopes and reissue token.' });
      }
      throw e;
    }

    const baseInput = {
      email,
      firstName: p.first_name || undefined,
      lastName:  p.last_name  || undefined,
      phone:     isPhone(p.phone) ? p.phone : undefined,
      addresses: p.home_address ? [{
        address1: p.home_address,
        firstName: p.first_name || undefined,
        lastName:  p.last_name  || undefined
      }] : undefined
    };

    if (!id){
      const cr = await gql(Q.customerCreate, { input: baseInput });
      const errs = cr.customerCreate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerCreate: ${JSON.stringify(errs)}` });
      id = cr.customerCreate.customer.id;
      state = cr.customerCreate.customer.state;
    } else {
      const up = await gql(Q.customerUpdate, { input: { id, ...baseInput } });
      const errs = up.customerUpdate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerUpdate: ${JSON.stringify(errs)}` });
    }

    // 2) uploads → Shopify Files
    const sig = p.signature_data_url        ? await uploadDataUrlToFiles(p.signature_data_url,        'Retainer signature') : { fileId:null, fileUrl:null };
    const dl  = p.license_data_url          ? await uploadDataUrlToFiles(p.license_data_url,          'Driver license')     : { fileId:null, fileUrl:null };
    const ci  = p.insurance_card_data_url   ? await uploadDataUrlToFiles(p.insurance_card_data_url,   'Insurance card')     : { fileId:null, fileUrl:null };

    // 3) pretty lists (no JSON arrays saved)
    const vehiclesArr  = Array.isArray(p.vehicles)  ? p.vehicles  : [];
    const householdArr = Array.isArray(p.household) ? p.household : [];

    const vehiclesList = vehiclesArr
      .filter(v => v && (v.year || v.make || v.model))
      .map(v => [v.year, v.make, v.model].filter(Boolean).join(' '));

    const householdList = householdArr
      .filter(h => h && (h.name || h.dob || h.relationship))
      .map(h => [h.name, h.dob, h.relationship].filter(Boolean).join(' — '));

    // 4) metafields
    const mf = [];
    if (nonBlank(p.dob) && isYMD(p.dob)) mf.push({ namespace:'retainer', ownerId:id, key:'dob', type:'date', value:p.dob });
    if (nonBlank(p.insurer))   mf.push({ namespace:'retainer', ownerId:id, key:'insurer',   type:'single_line_text_field', value:String(p.insurer) });
    if (nonBlank(p.bi_limits)) mf.push({ namespace:'retainer', ownerId:id, key:'bi_limits', type:'single_line_text_field', value:String(p.bi_limits) });

    mf.push({ namespace:'retainer', ownerId:id, key:'has_bi',     type:'boolean',        value: p.has_bi ? 'true' : 'false' });
    mf.push({ namespace:'retainer', ownerId:id, key:'cars_count', type:'number_integer', value: String(p.cars_count ?? 0) });

    // Pretty lists (Admin-friendly); create definitions for these keys as list of text
    if (vehiclesList.length)  mf.push({ namespace:'retainer', ownerId:id, key:'vehicles_list',  type:'list.single_line_text_field', value: JSON.stringify(vehiclesList) });
    if (householdList.length) mf.push({ namespace:'retainer', ownerId:id, key:'household_list', type:'list.single_line_text_field', value: JSON.stringify(householdList) });

    if (nonBlank(p.intake_notes)) mf.push({ namespace:'retainer', ownerId:id, key:'intake_notes', type:'multi_line_text_field', value:String(p.intake_notes) });

    if (nonBlank(p.retainer_plan)) {
      mf.push({ namespace:'retainer', ownerId:id, key:'last_retainer_plan',    type:'single_line_text_field', value:String(p.retainer_plan) });
      mf.push({ namespace:'retainer', ownerId:id, key:'current_retainer_plan', type:'single_line_text_field', value:String(p.retainer_plan) });
    }
    if (nonBlank(p.retainer_term)) {
      mf.push({ namespace:'retainer', ownerId:id, key:'last_retainer_term',    type:'single_line_text_field', value:String(p.retainer_term) });
      mf.push({ namespace:'retainer', ownerId:id, key:'current_retainer_term', type:'single_line_text_field', value:String(p.retainer_term) });
    }

    // Files
    if (sig.fileId) mf.push({ namespace:'retainer', ownerId:id, key:'signature',       type:'file_reference', value: JSON.stringify({ file_id: sig.fileId }) });
    if (dl.fileId)  mf.push({ namespace:'retainer', ownerId:id, key:'drivers_license', type:'file_reference', value: JSON.stringify({ file_id: dl.fileId  }) });
    if (ci.fileId)  mf.push({ namespace:'retainer', ownerId:id, key:'car_insurance',   type:'file_reference', value: JSON.stringify({ file_id: ci.fileId  }) });

    if (mf.length){
      const result = await gql(Q.metafieldsSet, { metafields: mf });
      const errs = result.metafieldsSet.userErrors || [];
      if (errs.length) return res.status(200).json({ ok:false, error:`metafieldsSet: ${JSON.stringify(errs)}` });
    }

    if (state !== 'ENABLED') sendInviteREST(id, email).catch(()=>{});

    return res.status(200).json({ ok:true, customer_id:id, customer_email:email });
  }catch(e){
    console.error('intake-upsert error', e);
    return res.status(200).json({ ok:false, error:String(e?.message || e) });
  }
}
