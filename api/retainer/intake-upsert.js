// JS (ESM) – Vercel serverless function
const SHOP   = process.env.SHOPIFY_SHOP;          // e.g. your-shop.myshopify.com
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
  if (!r.ok || j.errors) throw new Error(JSON.stringify(j));
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
    }`
};

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'missing email' });

    // find or create/update customer
    const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
    let id = found.customers.nodes[0]?.id;
    let state = found.customers.nodes[0]?.state;

    if (!id) {
      const created = await gql(Q.customerCreate, {
        input: {
          email,
          firstName: p.first_name || undefined,
          lastName:  p.last_name  || undefined,
          phone:     p.phone      || undefined,
          addresses: p.home_address ? [{
            address1: p.home_address,
            firstName: p.first_name || undefined,
            lastName:  p.last_name  || undefined
          }] : undefined
        }
      });
      id = created.customerCreate.customer.id;
      state = created.customerCreate.customer.state;
    } else {
      await gql(Q.customerUpdate, {
        id,
        input: {
          firstName: p.first_name || undefined,
          lastName:  p.last_name  || undefined,
          phone:     p.phone      || undefined,
          addresses: p.home_address ? [{
            address1: p.home_address,
            firstName: p.first_name || undefined,
            lastName:  p.last_name  || undefined
          }] : undefined
        }
      });
    }

    // write customer metafields
    const cmf = [
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

    await gql(Q.metafieldsSet, { metafields: cmf });

    // send Classic invite if not enabled
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
