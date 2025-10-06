// Vercel Serverless Function — Intake Upsert (Final)
// Creates/updates Customer, writes metafields (namespace "retainer"),
// uploads signature to Files, and stores file_reference at retainer.signature.

const SHOP   = process.env.SHOPIFY_SHOP;
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
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
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
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
  customersByEmail: `
    query($q:String!){
      customers(first:1, query:$q){ nodes{ id email state } }
    }`,
  customerCreate: `
    mutation($input:CustomerInput!){
      customerCreate(input:$input){
        customer{ id email state }
        userErrors{ field message }
      }
    }`,
  customerUpdate: `
    mutation($input:CustomerInput!){
      customerUpdate(input:$input){
        customer{ id email state }
        userErrors{ field message }
      }
    }`,
  metafieldsSet: `
    mutation($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){
        metafields{ namespace key type }
        userErrors{ field message }
      }
    }`,
  stagedUploadsCreate: `
    mutation($input:[StagedUploadInput!]!){
      stagedUploadsCreate(input:$input){
        stagedTargets{ url resourceUrl parameters{ name value } }
        userErrors{ field message }
      }
    }`,
  fileCreate: `
    mutation($files:[FileCreateInput!]!){
      fileCreate(files:$files){
        files{ id alt url }
        userErrors{ field message }
      }
    }`
};

// === Upload signature PNG to Shopify Files ===
async function uploadSignatureToFiles(dataUrl){
  if (!dataUrl || !dataUrl.startsWith('data:image/png')) return null;
  const base64 = dataUrl.split(',')[1];
  const buf = Buffer.from(base64, 'base64');

  const su = await gql(Q.stagedUploadsCreate, {
    input: [{
      resource: "FILE",
      filename: `signature-${Date.now()}.png`,
      mimeType: "image/png",
      httpMethod: "POST"
    }]
  });
  const target = su.stagedUploadsCreate.stagedTargets?.[0];
  if (!target?.url) return null;

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type:'image/png' }), 'signature.png');
  await fetch(target.url, { method:'POST', body: form });

  const fc = await gql(Q.fileCreate, {
    files: [{ contentType: "IMAGE", originalSource: target.resourceUrl, alt: "Retainer signature" }]
  });
  const file = fc.fileCreate.files?.[0];
  return file?.id || null;
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'missing email' });

    // === 1. find or create/update customer ===
    let id, state;
    const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
    id = found.customers.nodes[0]?.id;
    state = found.customers.nodes[0]?.state;

    const baseInput = {
      email,
      firstName: p.first_name || undefined,
      lastName:  p.last_name  || undefined,
      phone:     p.phone || undefined,
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

    // === 2. upload signature (optional) ===
    let signatureFileId = null;
    if (p.signature_data_url) {
      try { signatureFileId = await uploadSignatureToFiles(p.signature_data_url); }
      catch(_) { /* non-blocking */ }
    }

    // === 3. write metafields ===
    const mf = [
      { namespace:'retainer', ownerId:id, key:'dob',                type:'date',                   value: p.dob || '' },
      { namespace:'retainer', ownerId:id, key:'insurer',            type:'single_line_text_field', value: p.insurer || '' },
      { namespace:'retainer', ownerId:id, key:'bi_limits',          type:'single_line_text_field', value: p.bi_limits || '' },
      { namespace:'retainer', ownerId:id, key:'has_bi',             type:'boolean',                value: p.has_bi ? 'true' : 'false' },
      { namespace:'retainer', ownerId:id, key:'cars_count',         type:'number_integer',         value: String(p.cars_count ?? 0) },
      { namespace:'retainer', ownerId:id, key:'vehicles_json',      type:'json',                   value: JSON.stringify(p.vehicles || []) },
      { namespace:'retainer', ownerId:id, key:'household_json',     type:'json',                   value: JSON.stringify(p.household || []) },
      { namespace:'retainer', ownerId:id, key:'intake_notes',       type:'multi_line_text_field',  value: p.intake_notes || '' },
      { namespace:'retainer', ownerId:id, key:'last_retainer_plan', type:'single_line_text_field', value: p.retainer_plan || '' },
      { namespace:'retainer', ownerId:id, key:'last_retainer_term', type:'single_line_text_field', value: p.retainer_term || '' }
    ];

    if (signatureFileId) {
      mf.push({
        namespace:'retainer',
        ownerId:id,
        key:'signature',
        type:'file_reference',
        value: JSON.stringify({ file_id: signatureFileId })
      });
    }

    const setRes = await gql(Q.metafieldsSet, { metafields: mf });
    const mfErrs = setRes.metafieldsSet.userErrors;
    if (mfErrs?.length) return res.status(200).json({ ok:false, error:`metafieldsSet userErrors: ${JSON.stringify(mfErrs)}` });

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('intake-upsert error:', e);
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
