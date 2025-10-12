// api/retainer/order-webhook.js
// Webhook topics: orders/create (and/or orders/paid)
//
// - Verifies HMAC (raw body)
// - Writes Order metafields (namespace: retainer)
// - Copies Customer file_reference uploads (signature, license, insurance card)
// - Derives pretty lists for household/vehicles if needed
// - Updates Customer last_retainer_* snapshot

import crypto from 'node:crypto';

const SHOP   = process.env.SHOPIFY_SHOP;          // your-store.myshopify.com
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;   // Admin API access token
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

export const config = {
  api: { bodyParser: false } // keep raw body for HMAC verification
};

// ---------- raw body / HMAC ----------
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
function verifyHmac(req, raw) {
  const recv = req.headers['x-shopify-hmac-sha256'] || '';
  if (!SECRET || !recv) return false;
  const digest = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(recv);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- GraphQL ----------
async function gql(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
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
    }`,
  customerRetainerFields: `
    query($id:ID!){
      customer(id:$id){
        id
        metafields(first:50, namespace:"retainer"){
          nodes{
            key
            type
            value
            reference{
              __typename
              ... on MediaImage { id image { url } }
              ... on GenericFile { id url }
            }
          }
        }
      }
    }`
};

// ---------- helpers ----------
const isYMD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));

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
      if (p?.name && p.value != null && String(p.value).trim() !== '') props[p.name] = p.value;
    }
  }
  return props;
}

// type-safe MetafieldsSet builders
const pushSL = (mfs, ownerId, key, val) => {
  const v = (val ?? '').toString().trim();
  if (v) mfs.push({ namespace:'retainer', ownerId, key, type:'single_line_text_field', value:v });
};
const pushDT = (mfs, ownerId, key, val) => {
  const v = (val ?? '').toString().trim();
  if (isYMD(v)) mfs.push({ namespace:'retainer', ownerId, key, type:'date', value:v });
};
const pushBL = (mfs, ownerId, key, tf) => {
  if (tf === true || tf === false) mfs.push({ namespace:'retainer', ownerId, key, type:'boolean', value: tf ? 'true' : 'false' });
};
const pushNI = (mfs, ownerId, key, n) => {
  const v = Number(n);
  if (Number.isInteger(v)) mfs.push({ namespace:'retainer', ownerId, key, type:'number_integer', value:String(v) });
};
const pushJSON = (mfs, ownerId, key, val) => {
  let str = typeof val === 'string' ? val : JSON.stringify(val ?? []);
  try { JSON.parse(str); mfs.push({ namespace:'retainer', ownerId, key, type:'json', value:str }); } catch(_){}
};
const pushLIST = (mfs, ownerId, key, arr) => {
  // list.single_line_text_field requires JSON array of strings
  if (Array.isArray(arr) && arr.length) {
    const clean = arr.map(s => String(s||'').trim()).filter(Boolean);
    if (clean.length) mfs.push({ namespace:'retainer', ownerId, key, type:'list.single_line_text_field', value: JSON.stringify(clean) });
  }
};
const pushFILE = (mfs, ownerId, key, fileGid) => {
  if (!fileGid) return;
  mfs.push({
    namespace:'retainer',
    ownerId,
    key,
    type:'file_reference',
    value: JSON.stringify({ file_id: fileGid }) // IMPORTANT: must be {"file_id": "gid://..."}
  });
};

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok');  // health check
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readRawBody(req);
  if (!verifyHmac(req, raw)) return res.status(401).send('invalid hmac');

  const order = JSON.parse(raw.toString('utf8'));

  try {
    const orderGid = `gid://shopify/Order/${order.id}`;
    const attrs     = pullCartAttributes(order);
    const props     = pullLineItemProps(order);

    // Values from checkout (line-item props override cart attributes)
    const v_plan  = props.retainer_plan || attrs.retainer_plan || '';
    const v_term  = props.retainer_term || attrs.retainer_term || '';
    const v_sname = props.signed_name   || attrs.retainer_signed_name || '';
    const v_sdate = props.signed_date   || attrs.retainer_signed_date || '';
    const v_hasbi = (props.intake_has_bi === 'yes') || (props.has_bi === 'true');
    const v_notes = props.intake_notes || '';
    const v_ins   = props.intake_insurer || props.insurer || '';
    const v_bi    = props.intake_bi_limits || props.bi_limits || '';
    const v_dob   = props.intake_dob || props.dob || '';
    const v_cars  = props.intake_cars_count ?? props.cars_count ?? null;

    // Raw JSON strings (still useful for admin/api use)
    const j_house = props.intake_household_json || '[]';
    const j_veh   = props.intake_vehicles_json  || '[]';

    // Build metafields for the Order
    const mfs = [];
    pushSL(mfs, orderGid, 'retainer_plan', v_plan);
    pushSL(mfs, orderGid, 'retainer_term', v_term);
    pushSL(mfs, orderGid, 'signed_name',  v_sname);
    pushDT(mfs, orderGid, 'signed_date',  v_sdate);
    pushBL(mfs, orderGid, 'has_bi', v_hasbi);
    pushSL(mfs, orderGid, 'insurer', v_ins);
    pushSL(mfs, orderGid, 'bi_limits', v_bi);
    pushDT(mfs, orderGid, 'dob', v_dob);
    if (v_cars !== null) pushNI(mfs, orderGid, 'cars_count', v_cars);
    // Optional: keep JSON for reference
    pushJSON(mfs, orderGid, 'intake_household_json', j_house);
    pushJSON(mfs, orderGid, 'intake_vehicles_json',  j_veh);
    if (v_notes) mfs.push({ namespace:'retainer', ownerId:orderGid, key:'intake_notes', type:'multi_line_text_field', value:String(v_notes) });

    // Derive pretty lists from the JSON if customer lists aren't copied later
    let hhListFromProps = [];
    let vListFromProps  = [];
    try {
      const arr = JSON.parse(j_house || '[]');
      if (Array.isArray(arr)) {
        hhListFromProps = arr
          .filter(h => h && (h.name || h.dob || h.relationship))
          .map(h => [h.name, h.dob, h.relationship].filter(Boolean).join(' — '));
      }
    } catch(_) {}
    try {
      const arr = JSON.parse(j_veh || '[]');
      if (Array.isArray(arr)) {
        vListFromProps = arr
          .filter(v => v && (v.year || v.make || v.model))
          .map(v => [v.year, v.make, v.model].filter(Boolean).join(' '));
      }
    } catch(_) {}

    // Resolve customer GID from payload
    let customerGid = order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : null;
    if (!customerGid && order.email) {
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(order.email.toLowerCase())}` });
      customerGid = found.customers.nodes[0]?.id || null;
    }

    // Copy file references + pretty lists from Customer (if available)
    if (customerGid) {
      const data  = await gql(Q.customerRetainerFields, { id: customerGid });
      const nodes = data?.customer?.metafields?.nodes || [];
      const byKey = Object.fromEntries(nodes.map(n => [n.key, n]));

      // File references on the Customer
      const sigRef = byKey.signature?.reference?.id || null;
      const dlRef  = byKey.drivers_license?.reference?.id || null;
      const icRef  = byKey.car_insurance?.reference?.id || null;

      pushFILE(mfs, orderGid, 'signature',       sigRef);
      pushFILE(mfs, orderGid, 'drivers_license', dlRef);
      pushFILE(mfs, orderGid, 'car_insurance',   icRef);

      // Pretty lists on the Customer (mirror if present)
      let hhList = null, vList = null;
      if (byKey.household_list?.type === 'list.single_line_text_field') {
        try { hhList = JSON.parse(byKey.household_list.value); } catch(_) {}
      }
      if (byKey.vehicles_list?.type === 'list.single_line_text_field') {
        try { vList = JSON.parse(byKey.vehicles_list.value); } catch(_) {}
      }
      if (Array.isArray(hhList) && hhList.length) pushLIST(mfs, orderGid, 'household_list', hhList);
      if (Array.isArray(vList)  && vList.length)  pushLIST(mfs, orderGid, 'vehicles_list',  vList);

      // If customer lists weren't available, fall back to derived lists from props
      if (!mfs.some(x => x.key === 'household_list') && hhListFromProps.length)
        pushLIST(mfs, orderGid, 'household_list', hhListFromProps);
      if (!mfs.some(x => x.key === 'vehicles_list') && vListFromProps.length)
        pushLIST(mfs, orderGid, 'vehicles_list', vListFromProps);
    } else {
      // No customer resolved → still write derived lists so email shows something
      if (hhListFromProps.length) pushLIST(mfs, orderGid, 'household_list', hhListFromProps);
      if (vListFromProps.length)  pushLIST(mfs, orderGid, 'vehicles_list',  vListFromProps);
    }

    // Write all Order metafields
    if (mfs.length) {
      const r = await gql(Q.metafieldsSet, { metafields: mfs });
      const errs = r.metafieldsSet?.userErrors || [];
      if (errs.length) console.warn('order metafields userErrors', errs);
    }

    // Update Customer last_* snapshot
    if (customerGid) {
      const cmf = [];
      if (v_plan) cmf.push({ namespace:'retainer', ownerId:customerGid, key:'last_retainer_plan', type:'single_line_text_field', value:String(v_plan) });
      if (v_term) cmf.push({ namespace:'retainer', ownerId:customerGid, key:'last_retainer_term', type:'single_line_text_field', value:String(v_term) });
      if (cmf.length) {
        const r = await gql(Q.metafieldsSet, { metafields: cmf });
        const errs = r.metafieldsSet?.userErrors || [];
        if (errs.length) console.warn('customer snapshot userErrors', errs);
      }
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('order-webhook error', e);
    // During development, keep 200 to avoid retry storms; switch to 500 once stable.
    res.status(200).send('error');
  }
}
