// /api/retainer/customer-create.js  (ESM on Vercel)
const SHOP = process.env.SHOPIFY_SHOP; // 9x161v-j4.myshopify.com
const SF_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN; // Storefront API access token
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
  const r = await fetch(`https://${SHOP}/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Storefront-Access-Token': SF_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error(`GraphQL HTTP ${r.status}: ${JSON.stringify(j.errors || j)}`);
  return j.data;
}

const M = {
  customerCreate: `
    mutation customerCreate($input: CustomerCreateInput!) {
      customerCreate(input: $input) {
        customer { id email }
        customerUserErrors { field message code }
      }
    }
  `,
};

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const p = req.body || {};
    const email = String(p.email || '').trim().toLowerCase();
    const password = String(p.password || '').trim();

    if (!email || !password) {
      return res.status(400).json({ ok:false, error:'Missing email or password' });
    }

    const input = {
      email,
      password, // user sets it here → account is immediately active
      firstName: p.first_name || null,
      lastName:  p.last_name  || null,
      phone:     p.phone      || null,
      acceptsMarketing: false
    };

    const data = await gql(M.customerCreate, { input });
    const errs = data.customerCreate.customerUserErrors || [];
    if (errs.length) {
      return res.status(200).json({ ok:false, error: `customerCreate errors: ${JSON.stringify(errs)}` });
    }

    return res.status(200).json({ ok:true, customer: data.customerCreate.customer });
  } catch (e) {
    console.error('customer-create error:', e);
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
