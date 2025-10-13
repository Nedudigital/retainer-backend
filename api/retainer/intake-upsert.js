// /api/retainer/intake-upsert.js
// Upsert Customer (with password via Storefront), upload signature & docs to Shopify Files,
// write retainer/* metafields. No JSON arrays for Household/Vehicles (pretty list only).
// Phone is required (loose validation). BI limits removed everywhere. No invite email.

// ENV:
// SHOPIFY_SHOP=yourstore.myshopify.com
// SHOPIFY_ADMIN_TOKEN=shpat_xxx  (Admin API)
// STOREFRONT_TOKEN=xxxx          (Storefront API)
// ALLOWED_ORIGINS=https://autocounsel.law,https://yourdomain.com

const SHOP    = process.env.SHOPIFY_SHOP;
const ADMIN   = process.env.SHOPIFY_ADMIN_TOKEN;
const SF_TOK  = process.env.STOREFRONT_TOKEN;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s=>s.trim()).filter(Boolean);

function cors(res, origin){
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

async function gqlAdmin(q, v){
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method:'POST',
    headers:{ 'X-Shopify-Access-Token': ADMIN, 'Content-Type':'application/json' },
    body: JSON.stringify({ query:q, variables:v })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    const errTxt = j.errors ? JSON.stringify(j.errors) : await r.text();
    throw new Error(`GraphQL(Admin) ${r.status}: ${errTxt}`);
  }
  return j.data;
}

async function gqlSF(q, v){
  const r = await fetch(`https://${SHOP}/api/2024-07/graphql.json`, {
    method:'POST',
    headers:{
      'X-Shopify-Storefront-Access-Token': SF_TOK,
      'Content-Type':'application/json'
    },
    body: JSON.stringify({ query:q, variables:v })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    const errTxt = j.errors ? JSON.stringify(j.errors) : await r.text();
    throw new Error(`GraphQL(Storefront) ${r.status}: ${errTxt}`);
  }
  return j.data;
}

const Q = {
  // Admin
  customersByEmail: `query($q:String!){
    customers(first:1, query:$q){ nodes{ id email state } }
  }`,
  customerUpdate:   `mutation($input:CustomerInput!){
    customerUpdate(input:$input){
      customer{ id email state }
      userErrors{ field message }
    }
  }`,
  customerCreate:   `mutation($input:CustomerInput!){
    customerCreate(input:$input){
      customer{ id email state }
      userErrors{ field message }
    }
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
  // IMPORTANT: File is a union (MediaImage | Video | GenericFile). Read URL via type fragments.
  fileCreate: `mutation($files:[FileCreateInput!]!){
    fileCreate(files:$files){
      files{
        id
        __typename
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
      }
      userErrors{ field message }
    }
  }`,
};

const SF = {
  customerCreate: `mutation($input: CustomerCreateInput!){
    customerCreate(input:$input){
      customer { id email }
      userErrors { field message }
    }
  }`
};

// validators
const isEmail=s=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').toLowerCase());
// loose phone check: keep digits/+ and require at least 10 characters
const isPhoneLoose = s => String(s||'').replace(/[^\d+]/g,'').length >= 10;
const isYMD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
const nonBlank=s=>typeof s==='string'? s.trim()!=='' : s!=null;

// DataURL → Shopify Files (IMAGE or FILE) → {fileId,fileUrl,error}
async function uploadDataUrlToFiles(dataUrl, alt='Upload'){
  if (!dataUrl || !dataUrl.startsWith('data:')) return { fileId:null, fileUrl:null, error:'invalid data url' };
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/^data:([^;]+)/)||[])[1] || 'application/octet-stream';
  const buf  = Buffer.from(b64,'base64');

  // 1) staged target
  const su = await gqlAdmin(Q.stagedUploadsCreate, {
    input:[{ resource:'FILE', filename:`upload-${Date.now()}`, mimeType:mime, httpMethod:'POST' }]
  });
  const suErrs = su.stagedUploadsCreate?.userErrors || [];
  if (suErrs.length) return { fileId:null, fileUrl:null, error:'stagedUploadsCreate: ' + JSON.stringify(suErrs) };
  const target = su.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url) return { fileId:null, fileUrl:null, error:'staged upload target missing' };

  // 2) POST binary
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type:mime }), 'upload');
  const up = await fetch(target.url, { method:'POST', body:form });
  if (!up.ok) {
    const txt = await up.text().catch(()=> '');
    return { fileId:null, fileUrl:null, error:`staged upload ${up.status}: ${txt}` };
  }

  // 3) create File record (IMAGE vs FILE) and get id + url (for logs/UI)
  const fc = await gqlAdmin(Q.fileCreate, {
    files:[{ contentType: mime.startsWith('image/') ? 'IMAGE' : 'FILE', originalSource: target.resourceUrl, alt }]
  });
  const fileNode = fc.fileCreate?.files?.[0];
  const fileId   = fileNode?.id || null;
  const fileUrl  = fileNode?.__typename === 'MediaImage'
    ? (fileNode.image?.url || null)
    : (fileNode?.url || null);
  if (!fileId) return { fileId:null, fileUrl:null, error:'fileCreate returned no id' };
  return { fileId, fileUrl, error:null };
}

export default async function handler(req,res){
  cors(res, req.headers.origin);
  if (req.method==='OPTIONS') return res.status(204).end();
  if (req.method!=='POST')     return res.status(405).end();

  try{
    const p = req.body || {};
    const email = String(p.email||'').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'invalid or missing email' });

    const first = (p.first_name||'').toString().trim();
    const last  = (p.last_name||'').toString().trim();
    const phoneRaw = (p.phone||'').toString().trim();
    if (!isPhoneLoose(phoneRaw)) return res.status(400).json({ ok:false, error:'invalid or missing phone' });

    // 1) Find existing customer by email
    let id, state;
    try{
      const found = await gqlAdmin(Q.customersByEmail, { q:`email:${JSON.stringify(email)}` });
      id = found.customers.nodes[0]?.id;
      state = found.customers.nodes[0]?.state;
    }catch(e){
      if (String(e).includes('ACCESS_DENIED')) {
        return res.status(200).json({ ok:false, error:'App lacks Protected customer data. Approve the scope in your app.' });
      }
      throw e;
    }

    // Prepare Admin-side update payload (addresses, phone, etc.)
    const baseInput = {
      email,
      firstName: first || undefined,
      lastName:  last  || undefined,
      phone:     phoneRaw || undefined,
      addresses: p.home_address ? [{
        address1:p.home_address,
        firstName:first || undefined,
        lastName: last  || undefined
      }] : undefined
    };

    if (!id){
      // Create passworded customer via **Storefront** (no invite/activation)
      const password = (p.password||'').toString().trim();
      if (!password) return res.status(400).json({ ok:false, error:'missing password' });

      if (!SF_TOK) return res.status(500).json({ ok:false, error:'Storefront token not configured' });

      const crSF = await gqlSF(SF.customerCreate, {
        input: { email, password, firstName:first||undefined, lastName:last||undefined }
      });
      const sfErrs = crSF.customerCreate?.userErrors || [];
      if (sfErrs.length){
        return res.status(200).json({ ok:false, error:`customerCreate(Storefront): ${JSON.stringify(sfErrs)}` });
      }

      // Fetch Admin ID then update Admin-side details (phone/address)
      const found2 = await gqlAdmin(Q.customersByEmail, { q:`email:${JSON.stringify(email)}` });
      id = found2.customers.nodes[0]?.id;
      state = found2.customers.nodes[0]?.state;

      if (!id) return res.status(200).json({ ok:false, error:'customer not visible in Admin after creation' });

      const up = await gqlAdmin(Q.customerUpdate, { input: { id, ...baseInput } });
      const errs = up.customerUpdate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerUpdate: ${JSON.stringify(errs)}` });
    } else {
      // Existing customer (cannot set/change password via Admin)
      const up = await gqlAdmin(Q.customerUpdate, { input: { id, ...baseInput } });
      const errs = up.customerUpdate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerUpdate: ${JSON.stringify(errs)}` });
    }

    // 2) Uploads (signature + optional license + insurance card)
    const sig = p.signature_data_url ? await uploadDataUrlToFiles(p.signature_data_url, 'Retainer signature') : {fileId:null,fileUrl:null};
    const dl  = p.license_data_url   ? await uploadDataUrlToFiles(p.license_data_url,   'Driver license')   : {fileId:null,fileUrl:null};
    const ci  = p.insurance_card_data_url ? await uploadDataUrlToFiles(p.insurance_card_data_url, 'Insurance card') : {fileId:null,fileUrl:null};

    // 3) Build pretty lists (strings) — NOT JSON objects
    const vehiclesArr  = Array.isArray(p.vehicles)  ? p.vehicles  : [];
    const householdArr = Array.isArray(p.household) ? p.household : [];

    const vehiclesList  = vehiclesArr
      .filter(v => v && (v.year || v.make || v.model))
      .map(v => [v.year, v.make, v.model].filter(Boolean).join(' ').trim());

    const householdList = householdArr
      .filter(h => h && (h.name || h.dob || h.relationship))
      .map(h => [h.name, h.dob, h.relationship].filter(Boolean).join(' — ').trim());

    // 4) Customer metafields write
    const mf = [];

    // primitives (NO bi_limits)
    if (nonBlank(p.dob) && isYMD(p.dob)) mf.push({ namespace:'retainer', ownerId:id, key:'dob',      type:'date', value:p.dob });
    if (nonBlank(p.insurer))             mf.push({ namespace:'retainer', ownerId:id, key:'insurer',  type:'single_line_text_field', value:String(p.insurer) });
    mf.push({ namespace:'retainer', ownerId:id, key:'has_bi',     type:'boolean',        value: p.has_bi ? 'true' : 'false' });
    mf.push({ namespace:'retainer', ownerId:id, key:'cars_count', type:'number_integer', value:String(p.cars_count ?? 0) });

    // pretty lists only (no *_json values)
    if (vehiclesList.length)  mf.push({ namespace:'retainer', ownerId:id, key:'vehicles_list',  type:'list.single_line_text_field', value: JSON.stringify(vehiclesList) });
    if (householdList.length) mf.push({ namespace:'retainer', ownerId:id, key:'household_list', type:'list.single_line_text_field', value: JSON.stringify(householdList) });

    if (nonBlank(p.intake_notes))  mf.push({ namespace:'retainer', ownerId:id, key:'intake_notes', type:'multi_line_text_field', value:String(p.intake_notes) });

    // plan snapshots
    if (nonBlank(p.retainer_plan)) {
      mf.push({ namespace:'retainer', ownerId:id, key:'last_retainer_plan',    type:'single_line_text_field', value:String(p.retainer_plan) });
      mf.push({ namespace:'retainer', ownerId:id, key:'current_retainer_plan', type:'single_line_text_field', value:String(p.retainer_plan) });
    }
    if (nonBlank(p.retainer_term)) {
      mf.push({ namespace:'retainer', ownerId:id, key:'last_retainer_term',    type:'single_line_text_field', value:String(p.retainer_term) });
      mf.push({ namespace:'retainer', ownerId:id, key:'current_retainer_term', type:'single_line_text_field', value:String(p.retainer_term) });
    }

    // Files → file_reference (VALUE = raw File GID string)
    if (sig.fileId) mf.push({ namespace:'retainer', ownerId:id, key:'signature',       type:'file_reference', value: sig.fileId });
    if (dl.fileId)  mf.push({ namespace:'retainer', ownerId:id, key:'drivers_license', type:'file_reference', value: dl.fileId  });
    if (ci.fileId)  mf.push({ namespace:'retainer', ownerId:id, key:'car_insurance',   type:'file_reference', value: ci.fileId  });

    if (mf.length){
      const result = await gqlAdmin(Q.metafieldsSet, { metafields: mf });
      const errs = result.metafieldsSet.userErrors||[];
      if (errs.length) return res.status(200).json({ ok:false, error:`metafieldsSet: ${JSON.stringify(errs)}` });
    }

    // No invite emails — account already created via Storefront
    return res.status(200).json({ ok:true, customer_id:id, customer_email:email });
  }catch(e){
    console.error('intake-upsert error', e);
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
