// /api/retainer/intake-upsert.js
// Upsert Customer (with password via Storefront), upload signature & docs to Shopify Files,
// write retainer/* metafields. No JSON arrays for Household/Vehicles (pretty list only).
// Phone is required (loose validation). BI limits removed everywhere. No invite email.
// Errors are returned in plain English via { ok:false, error:"..." }.

const SHOP    = process.env.SHOPIFY_SHOP;
const ADMIN   = process.env.SHOPIFY_ADMIN_TOKEN;
const SF_TOK  = process.env.STOREFRONT_TOKEN;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s=>s.trim()).filter(Boolean);

/* ---------- CORS ---------- */
function cors(res, origin){
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

/* ---------- GraphQL helpers ---------- */
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

/* ---------- Queries ---------- */
const Q = {
  customersByEmail: `query($q:String!){
    customers(first:1, query:$q){ nodes{ id email state } }
  }`,
  customerUpdate: `mutation($input:CustomerInput!){
    customerUpdate(input:$input){
      customer{ id email state }
      userErrors{ field message }
    }
  }`,
  customerCreate: `mutation($input:CustomerInput!){
    customerCreate(input:$input){
      customer{ id email state }
      userErrors{ field message }
    }
  }`,
  metafieldsSet: `mutation($metafields:[MetafieldsSetInput!]!){
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

/* ---------- Validators ---------- */
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').toLowerCase());
// loose phone check: keep digits/+ and require at least 10 characters
const isPhoneLoose = s => String(s||'').replace(/[^\d+]/g,'').length >= 10;
const isYMD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
const nonBlank = s => typeof s==='string' ? s.trim()!=='' : s!=null;

/* ---------- Password helper (derive from last name/DOB) ---------- */
function derivePassword(p){
  const last = String(p.last_name || p.last || '').trim() || 'Member';
  const dob4 = String(p.dob || '').replace(/\D/g,'').slice(0,4); // e.g. '1992'
  // Ensure ≥ 8 chars and include at least one non-alpha to satisfy Shopify rules reliably
  let pw = (last + (dob4 || '123')) + '!';
  if (pw.length < 8) pw = (pw + '!!!!!!!!').slice(0, 12);
  return pw;
}


/* ---------- Error → plain-English ---------- */
function toPlainError(err){
  const s = String(err || '');

  // Pull Shopify userErrors JSON we included in messages
  const mCU = s.match(/customerUpdate:\s*(\[.*\])$/);
  const mCC = s.match(/customerCreate\(Storefront\):\s*(\[.*\])$/);
  const mMF = s.match(/metafieldsSet:\s*(\[.*\])$/);
  const raw = mCU?.[1] || mCC?.[1] || mMF?.[1];

  if (raw){
    try{
      const arr = JSON.parse(raw);
      const msgs = [];
      for (const e of arr){
        const field = (e?.field || []).join('.').toLowerCase();
        let msg = e?.message || '';

        // Friendly rewrites for common fields
        if (field.includes('phone') || /phone/i.test(msg)) {
          msg = 'Phone number looks invalid. Please enter a 10-digit US number.';
        } else if (field.includes('email') || /email/i.test(msg)) {
          msg = 'Email address looks invalid.';
        } else if (field.includes('password') || /password/i.test(msg)) {
          msg = 'Password doesn’t meet requirements.';
        }

        if (msg && !msgs.includes(msg)) msgs.push(msg);
      }
      if (msgs.length) return { error: msgs.join(' ') };
    }catch(_){}
  }

  // Known strings from this route
  if (s.includes('invalid or missing phone')) return { error:'Phone number is required and must have at least 10 digits.' };
  if (s.includes('invalid or missing email')) return { error:'Email address is required and must be valid.' };
  if (s.includes('missing password'))         return { error:'A password is required to create your account.' };
  if (s.includes('Storefront token not configured')) return { error:'Storefront API access is not configured.' };
  if (s.includes('ACCESS_DENIED'))            return { error:'Shopify permissions are missing (protected customer data scope).' };
  if (s.includes('customer not visible in Admin after creation')) return { error:'Customer created but not yet visible in Admin. Please try again.' };

  // Generic fallback
  return { error: s || 'Something went wrong. Please try again.' };
}

/* ---------- Customer update that tolerates phone errors ---------- */
async function customerUpdateSoft(input){
  const up = await gqlAdmin(Q.customerUpdate, { input });
  const errs = up.customerUpdate?.userErrors || [];
  if (!errs.length) return { ok:true, droppedPhone:false };

  // If every error is phone-related, retry without phone
  const phoneErrs = errs.filter(e =>
    (e?.field||[]).join('.').toLowerCase().includes('phone') ||
    String(e?.message||'').toLowerCase().includes('phone')
  );

  if (phoneErrs.length && phoneErrs.length === errs.length && input.phone){
    const { phone, ...rest } = input;
    const up2 = await gqlAdmin(Q.customerUpdate, { input: rest });
    const errs2 = up2.customerUpdate?.userErrors || [];
    if (!errs2.length) return { ok:true, droppedPhone:true };
    return { ok:false, errs: errs2 };
  }

  return { ok:false, errs };
}

/* ---------- DataURL → Shopify Files ---------- */
// Returns {fileId,fileUrl,error}
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

/* ---------- Handler ---------- */
export default async function handler(req,res){
  cors(res, req.headers.origin);
  if (req.method==='OPTIONS') return res.status(204).end();
  if (req.method!=='POST')     return res.status(405).end();

  try{
    const p = req.body || {};
    const email = String(p.email||'').trim().toLowerCase();
    if (!isEmail(email)) {
      const plain = toPlainError('invalid or missing email');
      return res.status(400).json({ ok:false, ...plain });
    }

    const first = (p.first_name||'').toString().trim();
    const last  = (p.last_name||'').toString().trim();
    const phoneRaw = (p.phone||'').toString().trim();
    if (!isPhoneLoose(phoneRaw)) {
      const plain = toPlainError('invalid or missing phone');
      return res.status(400).json({ ok:false, ...plain });
    }

    // 1) Find existing customer by email
    let id, state;
    try{
      const found = await gqlAdmin(Q.customersByEmail, { q:`email:${JSON.stringify(email)}` });
      id = found.customers.nodes[0]?.id;
      state = found.customers.nodes[0]?.state;
    }catch(e){
      if (String(e).includes('ACCESS_DENIED')) {
        return res.status(200).json({ ok:false, ...toPlainError('ACCESS_DENIED') });
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
// Use provided password OR auto-derive from last name/DOB
const password = (p.password ? String(p.password).trim() : derivePassword(p));


      if (!SF_TOK) return res.status(500).json({ ok:false, ...toPlainError('Storefront token not configured') });

      const crSF = await gqlSF(SF.customerCreate, {
        input: { email, password, firstName:first||undefined, lastName:last||undefined }
      });
      const sfErrs = crSF.customerCreate?.userErrors || [];
      if (sfErrs.length){
        const plain = toPlainError(`customerCreate(Storefront): ${JSON.stringify(sfErrs)}`);
        return res.status(200).json({ ok:false, ...plain });
      }

      // Fetch Admin ID then update Admin-side details (phone/address)
      const found2 = await gqlAdmin(Q.customersByEmail, { q:`email:${JSON.stringify(email)}` });
      id = found2.customers.nodes[0]?.id;
      state = found2.customers.nodes[0]?.state;

      if (!id) return res.status(200).json({ ok:false, ...toPlainError('customer not visible in Admin after creation') });

      const rUpd = await customerUpdateSoft({ id, ...baseInput });
      if (!rUpd.ok){
        const plain = toPlainError(`customerUpdate: ${JSON.stringify(rUpd.errs || [])}`);
        return res.status(200).json({ ok:false, ...plain });
      }
    } else {
      // Existing customer (cannot set/change password via Admin)
      const rUpd = await customerUpdateSoft({ id, ...baseInput });
      if (!rUpd.ok){
        const plain = toPlainError(`customerUpdate: ${JSON.stringify(rUpd.errs || [])}`);
        return res.status(200).json({ ok:false, ...plain });
      }
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

    // (Optional) store normalized digits if provided
    if (nonBlank(p.phone_digits)) {
      mf.push({ namespace:'retainer', ownerId:id, key:'phone_digits', type:'single_line_text_field', value:String(p.phone_digits) });
    }

    // Files → file_reference (VALUE = raw File GID string)
    if (sig.fileId) mf.push({ namespace:'retainer', ownerId:id, key:'signature',       type:'file_reference', value: sig.fileId });
    if (dl.fileId)  mf.push({ namespace:'retainer', ownerId:id, key:'drivers_license', type:'file_reference', value: dl.fileId  });
    if (ci.fileId)  mf.push({ namespace:'retainer', ownerId:id, key:'car_insurance',   type:'file_reference', value: ci.fileId  });

    if (mf.length){
      const result = await gqlAdmin(Q.metafieldsSet, { metafields: mf });
      const errs = result.metafieldsSet.userErrors||[];
      if (errs.length){
        const plain = toPlainError(`metafieldsSet: ${JSON.stringify(errs)}`);
        return res.status(200).json({ ok:false, ...plain });
      }
    }

    // Success
    return res.status(200).json({ ok:true, customer_id:id, customer_email:email });
  }catch(e){
    console.error('intake-upsert error', e);
    const plain = toPlainError(String(e?.message||e));
    return res.status(200).json({ ok:false, ...plain });
  }
}
