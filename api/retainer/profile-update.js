// /api/retainer/profile-update.js
// Update retainer customer metafields and optionally replace signature/files.

const SHOP   = process.env.SHOPIFY_SHOP;        // e.g. autcounsel.myshopify.com
const ADMIN  = process.env.SHOPIFY_ADMIN_TOKEN; // Admin API access token
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);

function cors(res, origin){
  if (origin && ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary','Origin'); }
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

async function gql(query, variables){
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method:'POST',
    headers:{ 'X-Shopify-Access-Token': ADMIN, 'Content-Type':'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    const err = j.errors ? JSON.stringify(j.errors) : await r.text();
    throw new Error(`GraphQL ${r.status}: ${err}`);
  }
  return j.data;
}

const Q = {
  customersByEmail: `query($q:String!){ customers(first:1, query:$q){ nodes{ id email state } } }`,
  customerUpdate:   `mutation($input:CustomerInput!){ customerUpdate(input:$input){ customer{ id } userErrors{ field message } } }`,
  metafieldsSet:    `mutation($metafields:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$metafields){ userErrors{ field message } } }`,
  stagedUploadsCreate: `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ field message } } }`,
  fileCreate: `mutation($files:[FileCreateInput!]!){ fileCreate(files:$files){ files{ id } userErrors{ field message } } }`,
  nodeUrl: `query($id:ID!){ node(id:$id){ ... on MediaImage { image{ url } } ... on GenericFile { url } } }`
};

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').toLowerCase());
const isYMD   = s => /^\d{4}-\d{2}-\d{2}$/.test(s||'');
const nonBlank= s => typeof s === 'string' ? s.trim() !== '' : s != null;

async function uploadDataUrlToFiles(dataUrl, alt='Upload'){
  if (!dataUrl || !dataUrl.startsWith('data:')) return { fileId:null, fileUrl:null, error:'invalid data url' };
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/^data:([^;]+)/)||[])[1] || 'application/octet-stream';
  const buf  = Buffer.from(b64,'base64');

  const su = await gql(Q.stagedUploadsCreate, { input:[{ resource:'FILE', filename:`upload-${Date.now()}`, mimeType:mime, httpMethod:'POST' }] });
  const target = su.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url) return { fileId:null, fileUrl:null, error:'staged upload target missing' };

  const form = new FormData();
  target.parameters.forEach(p=> form.append(p.name,p.value));
  form.append('file', new Blob([buf], { type:mime }), 'upload');
  const up = await fetch(target.url, { method:'POST', body:form });
  if (!up.ok) return { fileId:null, fileUrl:null, error:`staged upload ${up.status}` };

  const fc = await gql(Q.fileCreate, { files:[{ contentType: mime.startsWith('image/')?'IMAGE':'FILE', originalSource: target.resourceUrl, alt }] });
  const f = fc.fileCreate?.files?.[0];
  if (!f?.id) return { fileId:null, fileUrl:null, error:'fileCreate failed' };

  // public URL (handy if you want to echo it back)
  let fileUrl = null;
  try {
    const d = await gql(Q.nodeUrl, { id: f.id });
    fileUrl = d?.node?.image?.url || d?.node?.url || null;
  } catch(_){}

  return { fileId: f.id, fileUrl, error:null };
}

export default async function handler(req, res){
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).end();

  try{
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:'invalid or missing email' });

    // find customer
    const found = await gql(Q.customersByEmail, { q:`email:${JSON.stringify(email)}` });
    const id = found.customers.nodes[0]?.id;
    if (!id) return res.status(200).json({ ok:false, error:'customer not found' });

    // optional phone/address updates could go here via customerUpdate

    // optional file replacements
    let sigFileId=null, dlFileId=null, icFileId=null;
    if (p.signature_data_url)        sigFileId = (await uploadDataUrlToFiles(p.signature_data_url, 'Retainer signature')).fileId;
    if (p.license_data_url)          dlFileId  = (await uploadDataUrlToFiles(p.license_data_url,   'Driver license')).fileId;
    if (p.insurance_card_data_url)   icFileId  = (await uploadDataUrlToFiles(p.insurance_card_data_url, 'Insurance card')).fileId;

    const mf = [];

    if (nonBlank(p.insurer))   mf.push({ namespace:'retainer', ownerId:id, key:'insurer',   type:'single_line_text_field', value:String(p.insurer) });
    if (nonBlank(p.bi_limits)) mf.push({ namespace:'retainer', ownerId:id, key:'bi_limits', type:'single_line_text_field', value:String(p.bi_limits) });
    if (p.has_bi === true || p.has_bi === false) mf.push({ namespace:'retainer', ownerId:id, key:'has_bi', type:'boolean', value: p.has_bi ? 'true' : 'false' });
    if (Number.isFinite(p.cars_count)) mf.push({ namespace:'retainer', ownerId:id, key:'cars_count', type:'number_integer', value:String(p.cars_count) });
    if (nonBlank(p.dob) && isYMD(p.dob)) mf.push({ namespace:'retainer', ownerId:id, key:'dob', type:'date', value:p.dob });
    if (nonBlank(p.intake_notes)) mf.push({ namespace:'retainer', ownerId:id, key:'intake_notes', type:'multi_line_text_field', value:String(p.intake_notes) });

    // pretty lists (arrays of strings) → list.single_line_text_field
    if (Array.isArray(p.household_list)) mf.push({ namespace:'retainer', ownerId:id, key:'household_list', type:'list.single_line_text_field', value: JSON.stringify(p.household_list.filter(Boolean)) });
    if (Array.isArray(p.vehicles_list))  mf.push({ namespace:'retainer', ownerId:id, key:'vehicles_list',  type:'list.single_line_text_field', value: JSON.stringify(p.vehicles_list.filter(Boolean)) });

    // new file_reference values if provided
    if (sigFileId) mf.push({ namespace:'retainer', ownerId:id, key:'signature',        type:'file_reference', value: `gid://shopify/GenericFile/${sigFileId.split('/').pop()}`.includes('GenericFile') ? JSON.stringify({ file_id: sigFileId }) : JSON.stringify({ file_id: sigFileId }) });
    if (dlFileId)  mf.push({ namespace:'retainer', ownerId:id, key:'drivers_license',  type:'file_reference', value: JSON.stringify({ file_id: dlFileId }) });
    if (icFileId)  mf.push({ namespace:'retainer', ownerId:id, key:'car_insurance',    type:'file_reference', value: JSON.stringify({ file_id: icFileId }) });

    if (mf.length){
      const result = await gql(Q.metafieldsSet, { metafields: mf });
      const errs = result.metafieldsSet.userErrors || [];
      if (errs.length) return res.status(200).json({ ok:false, error:`metafieldsSet: ${JSON.stringify(errs)}` });
    }

    return res.status(200).json({ ok:true });
  }catch(e){
    console.error('profile-update error', e);
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
