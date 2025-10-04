// JS (ESM) – Vercel serverless function
// Creates/updates a Customer, writes customer metafields (namespace "retainer"),
// uploads signature to Files, and saves a file_reference metafield at custom.retainer_signature.
// Sends the classic "Activate your account" invite if the customer is not enabled.

const SHOP   = process.env.SHOPIFY_SHOP;          // e.g. 9x161v-j4.myshopify.com
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;   // Admin API token
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

function isValidPhone(s){ return /^\+?[1-9]\d{7,14}$/.test(s || ''); }

async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) {
    const err = (j && j.errors) ? JSON.stringify(j.errors) : await r.text();
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
    mutation($id:ID!, $input:CustomerInput!){
      customerUpdate(id:$id, input:$input){
        customer{ id email state }
        userErrors{ field message }
      }
    }`,
  customerSendInvite: `
    mutation($id:ID!, $input:CustomerInviteInput!){
      customerSendInvite(id:$id, input:$input){
        customerInvite{ to }
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
        stagedTargets{
          url resourceUrl parameters{ name value }
        }
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

async function uploadSignatureToFiles(dataUrl){
  if (!dataUrl || !dataUrl.startsWith('data:image/png')) return null;

  // 1) decode base64
  const base64 = dataUrl.split(',')[1];
  const buf = Buffer.from(base64, 'base64');

  // 2) staged upload target
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

  // 3) post to staged URL
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type:'image/png' }), 'signature.png');
  await fetch(target.url, { method:'POST', body: form });

  // 4) create file record
  const fc = await gql(Q.fileCreate, {
    files: [{ contentType: "IMAGE", originalSource: target.resourceUrl, alt: "Retainer signature" }]
  });
  const file = fc.fileCreate.files?.[0];
  return file?.id || null; // GraphQL ID e.g. gid://shopify/MediaImage/...
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'missing email' });

    // 1) find or create/update customer
    let id, state;
    try {
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
      id = found.customers.nodes[0]?.id;
      state = found.customers.nodes[0]?.state;
    } catch (e) {
      if (String(e).includes('ACCESS_DENIED')) {
        return res.status(200).json({
          ok:false,
          error:'Shopify blocked Customer access (Protected customer data). Approve access in app settings, reinstall the app, and update the Admin token.'
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
      const updated = await gql(Q.customerUpdate, { id, input: baseInput });
      const errs = updated.customerUpdate.userErrors;
      if (errs?.length) return res.status(200).json({ ok:false, error:`customerUpdate userErrors: ${JSON.stringify(errs)}` });
    }

    // 2) (optional) upload signature and get File ID
    let signatureFileId = null;
    if (p.signature_data_url) {
      try { signatureFileId = await uploadSignatureToFiles(p.signature_data_url); }
      catch(_) { /* non-blocking */ }
    }

    // 3) write Customer metafields
    const mf = [
      { key:'dob',                type:'date',                   value: p.dob || '' },
      { key:'insurer',            type:'single_line_text_field', value: p.insurer || '' },
      { key:'bi_limits',          type:'single_line_text_field', value: p.bi_limits || '' },
      { key:'has_bi',             type:'boolean',                value: p.has_bi ? 'true' : 'false' },
      { key:'cars_count',         type:'number_integer',         value: String(p.cars_count ?? 0) },
      { key:'vehicles_json',      type:'json',                   value: JSON.stringify(p.vehicles || []) },
      { key:'household_json',     type:'json',                   value: JSON.stringify(p.household || []) },
      { key:'intake_notes',       type:'multi_line_text_field',  value: p.intake_notes || '' },
      { key:'last_retainer_plan', type:'single_line_text_field', value: p.retainer_plan || '' },
      { key:'last_retainer_term', type:'single_line_text_field', value: p.retainer_term || '' }
    ].map(m => ({ ...m, namespace:'retainer', ownerId: id }));

    // Signature as file_reference at custom.retainer_signature
    if (signatureFileId) {
      mf.push({
        namespace:'custom',
        ownerId: id,
        key:'retainer_signature',
        type:'file_reference',
        value: JSON.stringify({ file_id: signatureFileId })
      });
    }

    await gql(Q.metafieldsSet, { metafields: mf });

    // 4) send Classic invite if not enabled
    if (state !== 'ENABLED') {
      await gql(Q.customerSendInvite, {
        id,
        input: {
          subject: 'Activate your AutoCounsel account',
          customMessage: 'Create your password to access your dashboard and documents.'
        }
      });
    }

    return res.status(200).json({ ok:true });
  } catch (e) {
    console.error('intake-upsert error:', e);
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
