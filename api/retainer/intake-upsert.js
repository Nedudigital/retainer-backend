// /api/retainer/intake-upsert.js
// Upsert Customer, upload signature & document files to Shopify Files, write retainer/* metafields,
// send invite if needed. No Supabase. No signature in checkout.

const SHOP   = process.env.SHOPIFY_SHOP;        // e.g. my-store.myshopify.com
const ADMIN  = process.env.SHOPIFY_ADMIN_TOKEN; // Admin API access token (Custom App)
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function cors(res, origin) {
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    const err = j.errors ? JSON.stringify(j.errors) : await r.text();
    throw new Error(`GraphQL HTTP ${r.status} ${r.statusText}: ${err}`);
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
    metafieldsSet(metafields:$metafields){
      metafields{ namespace key type }
      userErrors{ field message }
    }
  }`,
  stagedUploadsCreate: `mutation($input:[StagedUploadInput!]!){
    stagedUploadsCreate(input:$input){
      stagedTargets{ url resourceUrl parameters{ name value } }
      userErrors{ field message }
    }
  }`,
  fileCreate: `mutation($files:[FileCreateInput!]!){
    fileCreate(files:$files){
      files{ id alt url }
      userErrors{ field message }
    }
  }`,
};

function isEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').toLowerCase()); }
function isValidPhone(s){ return /^\+?[1-9]\d{7,14}$/.test(s || ''); }
function isYMD(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
function nonBlank(s){ return typeof s === 'string' ? s.trim() !== '' : s != null; }

// Generic dataURL uploader → Shopify Files (IMAGE or FILE)
async function uploadDataUrlToFiles(dataUrl, suggestedAlt = 'Upload'){
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    return { fileId:null, fileUrl:null, error:'data_url missing/invalid' };
  }
  const [meta, base64] = dataUrl.split(',');
  const mime = (meta.match(/^data:([^;]+)/)||[])[1] || 'application/octet-stream';
  const isImage = mime.startsWith('image/');
  const buf = Buffer.from(base64, 'base64');

  // 1) staged target
  const su = await gql(Q.stagedUploadsCreate, {
    input: [{ resource:"FILE", filename:`upload-${Date.now()}`, mimeType:mime, httpMethod:"POST" }]
  });
  const suErrs = su.stagedUploadsCreate?.userErrors || [];
  if (suErrs.length) return { fileId:null, fileUrl:null, error:'stagedUploadsCreate: ' + JSON.stringify(suErrs) };

  const target = su.stagedUploadsCreate.stagedTargets?.[0];
  if (!target?.url) return { fileId:null, fileUrl:null, error:'stagedUploadsCreate returned no target.url' };

  // 2) POST binary
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type:mime }), `upload-${Date.now()}`);
  const up = await fetch(target.url, { method:'POST', body: form });
  if (!up.ok) {
    const t = await up.text().catch(()=> '');
    return { fileId:null, fileUrl:null, error:`staged upload HTTP ${up.status}: ${t}` };
  }

  // 3) create file record (IMAGE vs FILE)
  const fc = await gql(Q.fileCreate, {
    files:[{ contentType: isImage ? "IMAGE" : "FILE", originalSource: target.resourceUrl, alt: suggestedAlt }]
  });
  const f = fc.fileCreate?.files?.[0];
  if (!f?.id) return { fileId:null, fileUrl:null, error:'fileCreate returned no file id' };
  return { fileId: f.id, fileUrl: f.url || null, error:null };
}

async function sendInviteREST(customerGid, email){
  try {
    const numericId = String(customerGid).split('/').pop();
    const url = `https://${SHOP}/admin/api/2024-07/customers/${numericId}/send_invite.json`;
    const r = await fetch(url, {
      method:'POST',
      headers:{ 'X-Shopify-Access-Token': ADMIN, 'Content-Type':'application/json' },
      body: JSON.stringify({ customer_invite: { to: email || undefined } })
    });
    if (!r.ok) console.warn('send_invite failed', r.status, await r.text().catch(()=> ''));
  } catch(e){ console.warn('sendInviteREST error', e); }
}

export default async function handler(req, res){
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).end();

  try {
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'invalid or missing email' });

    // 1) Find or create/update Customer
    let id, state;
    try {
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
      id = found.customers.nodes[0]?.id;
      state = found.customers.nodes[0]?.state;
    } catch (e) {
      if (String(e).includes('ACCESS_DENIED')) {
        return res.status(200).json({
          ok:false,
          error:'Shopify blocked Customer access (Protected customer data). Approve access in the app and update the Admin token.'
        });
      }
      throw e;
    }

    const baseInput = {
      email,
      firstName: p.first_name || undefined,
      lastName:  p.last_name  || undefined,
      phone:     isValidPhone(p.phone) ? p.phone : undefined,
      addresses: p.home_address ? [{
        address1: p.home_address,
        firstName: p.first_name || undefined,
        lastName:  p.last_name  || undefined
      }] : undefined
    };

    if (!id) {
      const created = await gql(Q.customerCreate, { input: baseInput });
      const errs = created.customerCreate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerCreate userErrors: ${JSON.stringify(errs)}` });
      id = created.customerCreate.customer.id;
      state = created.customerCreate.customer.state;
    } else {
      const updated = await gql(Q.customerUpdate, { input: { id, ...baseInput } });
      const errs = updated.customerUpdate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerUpdate userErrors: ${JSON.stringify(errs)}` });
    }

    // 2) Uploads (signature + optional license + insurance card)
    let sig = { attempted: !!p.signature_data_url, uploaded:false, file_id:null, file_url:null, error:null };
    if (p.signature_data_url) {
      try {
        const up = await uploadDataUrlToFiles(p.signature_data_url, 'Retainer signature');
        sig = { attempted:true, uploaded: !!up.fileId, file_id: up.fileId || null, file_url: up.fileUrl || null, error: up.error || null };
      } catch (e) {
        sig = { attempted:true, uploaded:false, file_id:null, file_url:null, error: String(e?.message || e) };
      }
    }

    let licenseFile = { file_id:null, file_url:null };
    if (p.license_data_url) {
      try {
        const up = await uploadDataUrlToFiles(p.license_data_url, 'Driver license');
        licenseFile = { file_id: up.fileId || null, file_url: up.fileUrl || null };
      } catch (e) { /* non-blocking */ }
    }

    let insuranceFile = { file_id:null, file_url:null };
    if (p.insurance_card_data_url) {
      try {
        const up = await uploadDataUrlToFiles(p.insurance_card_data_url, 'Insurance card');
        insuranceFile = { file_id: up.fileId || null, file_url: up.fileUrl || null };
      } catch (e) { /* non-blocking */ }
    }

    // 3) Build “pretty” lists for Admin UI and also keep JSON
    const vehicles  = Array.isArray(p.vehicles)  ? p.vehicles  : [];
    const household = Array.isArray(p.household) ? p.household : [];

    const vehiclesList = vehicles
      .filter(v => v && (v.year || v.make || v.model))
      .map(v => `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim())
      .filter(Boolean);

    const householdList = household
      .filter(h => h && (h.name || h.dob || h.relationship))
      .map(h => [h.name, h.dob, h.relationship].filter(Boolean).join(' — '))
      .filter(Boolean);

    // 4) Customer metafields write
    const mf = [];

    if (nonBlank(p.dob) && isYMD(p.dob)) mf.push({ namespace:'retainer', ownerId:id, key:'dob', type:'date', value: p.dob });
    if (nonBlank(p.insurer))   mf.push({ namespace:'retainer', ownerId:id, key:'insurer',   type:'single_line_text_field', value: String(p.insurer) });
    if (nonBlank(p.bi_limits)) mf.push({ namespace:'retainer', ownerId:id, key:'bi_limits', type:'single_line_text_field', value: String(p.bi_limits) });
    mf.push({ namespace:'retainer', ownerId:id, key:'has_bi',     type:'boolean',        value: p.has_bi ? 'true' : 'false' });
    mf.push({ namespace:'retainer', ownerId:id, key:'cars_count', type:'number_integer', value: String(p.cars_count ?? 0) });

    // JSON (programmatic)
    mf.push({ namespace:'retainer', ownerId:id, key:'vehicles_json',  type:'json', value: JSON.stringify(vehicles) });
    mf.push({ namespace:'retainer', ownerId:id, key:'household_json', type:'json', value: JSON.stringify(household) });

    // Pretty lists for Admin UI
    mf.push({ namespace:'retainer', ownerId:id, key:'vehicles_list',  type:'list.single_line_text_field', value: JSON.stringify(vehiclesList) });
    mf.push({ namespace:'retainer', ownerId:id, key:'household_list', type:'list.single_line_text_field', value: JSON.stringify(householdList) });

    if (nonBlank(p.intake_notes))  mf.push({ namespace:'retainer', ownerId:id, key:'intake_notes',      type:'multi_line_text_field', value: String(p.intake_notes) });
    if (nonBlank(p.retainer_plan)) mf.push({ namespace:'retainer', ownerId:id, key:'last_retainer_plan', type:'single_line_text_field', value: String(p.retainer_plan) });
    if (nonBlank(p.retainer_term)) mf.push({ namespace:'retainer', ownerId:id, key:'last_retainer_term', type:'single_line_text_field', value: String(p.retainer_term) });

    // Files → file_reference
    if (sig.file_id)        mf.push({ namespace:'retainer', ownerId:id, key:'signature',           type:'file_reference', value: JSON.stringify({ file_id: sig.file_id }) });
    if (licenseFile.file_id)   mf.push({ namespace:'retainer', ownerId:id, key:'license_file',        type:'file_reference', value: JSON.stringify({ file_id: licenseFile.file_id }) });
    if (insuranceFile.file_id) mf.push({ namespace:'retainer', ownerId:id, key:'insurance_card_file', type:'file_reference', value: JSON.stringify({ file_id: insuranceFile.file_id }) });

    if (mf.length) {
      const result = await gql(Q.metafieldsSet, { metafields: mf });
      const errs = result.metafieldsSet.userErrors || [];
      if (errs.length) {
        return res.status(200).json({ ok:false, error:`metafieldsSet userErrors: ${JSON.stringify(errs)}`, sig, licenseFile, insuranceFile });
      }
    }

    if (state !== 'ENABLED') { sendInviteREST(id, email).catch(()=>{}); }

    return res.status(200).json({
      ok: true,
      customer_id: id,
      customer_email: email,
      wrote_namespace: 'retainer',
      sig,
      licenseFile,
      insuranceFile
    });
  } catch (e) {
    console.error('intake-upsert error:', e);
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
