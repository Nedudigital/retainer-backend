// /api/retainer/intake-upsert.js
const SHOP   = process.env.SHOPIFY_SHOP;          // e.g. 9x161v-j4.myshopify.com
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;   // Admin API access token
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
  let j;
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok || (j && j.errors)) {
    throw new Error(`GraphQL HTTP ${r.status} ${r.statusText}: ${JSON.stringify(j?.errors || j)}`);
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
    }`
};

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok:false, error:'Method not allowed' });

  // Quick env sanity
  if (!SHOP || !TOKEN) {
    return res.status(500).json({ ok:false, error:'Missing SHOPIFY_SHOP or SHOPIFY_ADMIN_TOKEN env' });
  }

  try {
    const p = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const email = String(p.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'missing email' });

    // 1) look up by email
    const search = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
    let node = search?.customers?.nodes?.[0] || null;

    // 2) create or update
    if (!node) {
      const created = await gql(Q.customerCreate, {
        input: {
          email,
          firstName: p.first_name || undefined,
          lastName:  p.last_name  || undefined,
          phone:     p.phone      || undefined,
          addresses: p.home_address ? [{
            address1:  p.home_address,
            firstName: p.first_name || undefined,
            lastName:  p.last_name  || undefined
          }] : undefined
        }
      });

      const ce = created?.customerCreate;
      const errs = ce?.userErrors || [];
      if (errs.length) {
        // If the email already exists, re-query and continue; otherwise bail with the real error
        const alreadyExists = errs.some(e => /email/i.test(e.field?.join?.('.') || '') || /already.*taken/i.test(e.message));
        if (alreadyExists) {
          const again = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
          node = again?.customers?.nodes?.[0] || null;
          if (!node) {
            return res.status(400).json({ ok:false, error:`Shopify says email exists, but lookup returned none: ${JSON.stringify(errs)}` });
          }
        } else {
          return res.status(400).json({ ok:false, error:`customerCreate userErrors: ${JSON.stringify(errs)}` });
        }
      } else {
        node = ce?.customer || null;
        if (!node) {
          // Extra safety: one more lookup
          const again = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(email)}` });
          node = again?.customers?.nodes?.[0] || null;
          if (!node) {
            return res.status(400).json({ ok:false, error:'customerCreate returned null customer and subsequent lookup failed' });
          }
        }
      }
    } else {
      const upd = await gql(Q.customerUpdate, {
        id: node.id,
        input: {
          firstName: p.first_name || undefined,
          lastName:  p.last_name  || undefined,
          phone:     p.phone      || undefined,
          addresses: p.home_address ? [{
            address1:  p.home_address,
            firstName: p.first_name || undefined,
            lastName:  p.last_name  || undefined
          }] : undefined
        }
      });
      const errs = upd?.customerUpdate?.userErrors || [];
      if (errs.length) {
        return res.status(400).json({ ok:false, error:`customerUpdate userErrors: ${JSON.stringify(errs)}` });
      }
      node = upd?.customerUpdate?.customer || node;
    }

    // At this point we must have an id/state
    if (!node?.id) {
      return res.status(400).json({ ok:false, error:'No customer ID after create/update.' });
    }

    // 3) set metafields
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
    ].map(m => ({ ...m, namespace:'retainer', ownerId: node.id }));

    const mf = await gql(Q.metafieldsSet, { metafields: cmf });
    const mfErrs = mf?.metafieldsSet?.userErrors || [];
    if (mfErrs.length) {
      // Don’t hard fail checkout on metafield mismatch; return warning
      console.warn('metafieldsSet userErrors', mfErrs);
    }

    // 4) send account invite if not enabled (Classic accounts)
    const state = node.state;
    if (state !== 'ENABLED') {
      const inv = await gql(Q.customerSendInvite, {
        id: node.id,
        input: {
          subject: 'Activate your AutoCounsel account',
          customMessage: 'Create your password to access your dashboard and documents.'
        }
      });
      const invErrs = inv?.customerSendInvite?.userErrors || [];
      if (invErrs.length) {
        console.warn('customerSendInvite userErrors', invErrs);
      }
    }

    return res.status(200).json({ ok:true, customerId: node.id, state: node.state });
  } catch (e) {
    console.error('intake-upsert error:', e);
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
