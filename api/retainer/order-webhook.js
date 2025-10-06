// api/retainer/order-webhook.js
// Receives orders/create or orders/paid
// - Verifies HMAC (raw body)
// - Writes order metafields (namespace: retainer)
// - Updates customer metafields (last_retainer_*)

import crypto from 'node:crypto';

const SHOP   = process.env.SHOPIFY_SHOP;
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

export const config = {
  api: { bodyParser: false } // keep raw for HMAC
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyHmac(req, raw) {
  const h = req.headers['x-shopify-hmac-sha256'] || '';
  if (!SECRET || !h) return false;
  const digest = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const left = Buffer.from(digest);
  const right = Buffer.from(h);
  // timingSafeEqual requires equal length
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
  if (!r.ok || j.errors) throw new Error(JSON.stringify(j.errors || j));
  return j.data;
}

const Q = {
  metafieldsSet: `
    mutation($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){
        metafields{ ownerType namespace key type }
        userErrors{ field message }
      }
    }`,
  customersByEmail: `
    query($q:String!){
      customers(first:1, query:$q){ nodes{ id email } }
    }`
};

// note_attributes == cart attributes on the order payload
function pullCartAttributes(order) {
  const map = {};
  for (const na of order.note_attributes || []) {
    if (na?.name) map[na.name] = na.value;
  }
  return map;
}

function pullLineItemProps(order) {
  const props = {};
  for (const li of order.line_items || []) {
    for (const p of li.properties || []) {
      if (p?.name && p.value != null && String(p.value).trim() !== '') {
        props[p.name] = p.value;
      }
    }
  }
  return props;
}

function isYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok'); // health
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readRawBody(req);
  if (!verifyHmac(req, raw)) return res.status(401).send('invalid hmac');

  const order = JSON.parse(raw.toString('utf8'));

  try {
    const attrs  = pullCartAttributes(order);
    const props  = pullLineItemProps(order);
    const orderGid = `gid://shopify/Order/${order.id}`;

    // Build typed metafields, but **skip** any invalid/blank values per type
    const mfs = [];

    // single_line_text_field (skip if blank)
    const sl = (key, val) => {
      const v = (val ?? '').toString().trim();
      if (v) mfs.push({ namespace:'retainer', ownerId:orderGid, key, type:'single_line_text_field', value:v });
    };

    // date (must be YYYY-MM-DD)
    const dt = (key, val) => {
      const v = (val ?? '').toString().trim();
      if (isYMD(v)) mfs.push({ namespace:'retainer', ownerId:orderGid, key, type:'date', value:v });
    };

    // boolean ('true'/'false')
    const bl = (key, truthy) => {
      const v = truthy ? 'true' : 'false';
      mfs.push({ namespace:'retainer', ownerId:orderGid, key, type:'boolean', value:v });
    };

    // number_integer (must be integer string)
    const ni = (key, val) => {
      const n = Number(val);
      if (Number.isInteger(n)) mfs.push({ namespace:'retainer', ownerId:orderGid, key, type:'number_integer', value:String(n) });
    };

    // json (must be valid JSON string)
    const js = (key, val, fallback = '[]') => {
      let str = typeof val === 'string' ? val : JSON.stringify(val ?? []);
      try { JSON.parse(str); mfs.push({ namespace:'retainer', ownerId:orderGid, key, type:'json', value:str }); }
      catch(_){ /* skip invalid json */ }
    };

    // Values from attributes/props (props override if present)
    const v_plan   = props.retainer_plan || attrs.retainer_plan || '';
    const v_term   = props.retainer_term || attrs.retainer_term || '';
    const v_sigurl = props.signature_url || attrs.retainer_signature_url || '';
    const v_sname  = props.signed_name || attrs.retainer_signed_name || '';
    const v_sdate  = props.signed_date || attrs.retainer_signed_date || '';
    const v_hasbi  = (props.intake_has_bi === 'yes') || (props.has_bi === 'true');
    const v_notes  = props.intake_notes || '';
    const v_ins    = props.intake_insurer || props.insurer || '';
    const v_bi     = props.intake_bi_limits || props.bi_limits || '';
    const v_dob    = props.intake_dob || props.dob || '';
    const v_cars   = props.intake_cars_count ?? props.cars_count ?? null;

    // JSON blobs from props
    const j_house  = props.intake_household_json || '[]';
    const j_veh    = props.intake_vehicles_json  || '[]';

    // Write them (only valid values make it through)
    sl('retainer_plan', v_plan);
    sl('retainer_term', v_term);
    sl('signature_url', v_sigurl);
    sl('signed_name', v_sname);
    dt('signed_date', v_sdate);
    bl('has_bi', v_hasbi);
    sl('insurer', v_ins);
    sl('bi_limits', v_bi);
    dt('dob', v_dob);
    if (v_cars !== null) ni('cars_count', v_cars);
    js('intake_household_json', j_house);
    js('intake_vehicles_json',  j_veh);
    if (v_notes) mfs.push({ namespace:'retainer', ownerId:orderGid, key:'intake_notes', type:'multi_line_text_field', value:String(v_notes) });

    if (mfs.length) {
      const r = await gql(Q.metafieldsSet, { metafields: mfs });
      const errs = r.metafieldsSet?.userErrors || [];
      if (errs.length) console.warn('order metafields userErrors', errs);
    }

    // Update customer last_* if we can resolve a customer
    let customerId = null;
    if (order.customer?.id) {
      customerId = `gid://shopify/Customer/${order.customer.id}`;
    } else if (order.email) {
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(order.email.toLowerCase())}` });
      customerId = found.customers.nodes[0]?.id || null;
    }

    if (customerId) {
      const cmf = [];
      if (v_plan) cmf.push({ namespace:'retainer', ownerId:customerId, key:'last_retainer_plan', type:'single_line_text_field', value:String(v_plan) });
      if (v_term) cmf.push({ namespace:'retainer', ownerId:customerId, key:'last_retainer_term', type:'single_line_text_field', value:String(v_term) });
      if (cmf.length) await gql(Q.metafieldsSet, { metafields: cmf });
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('order-webhook error', e);
    // return 200 during debugging to avoid retry storms; flip to 500 later if desired
    res.status(200).send('error');
  }
}
