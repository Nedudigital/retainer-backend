// Receives orders/create or orders/paid
// - Verifies HMAC (raw body)
// - Copies cart attributes / line-item properties → Order metafields (namespace: retainer)
// - Copies Customer file references (signature, license, insurance card) → Order metafields
// - Updates Customer last_retainer_* from the order

import crypto from 'node:crypto';

const SHOP   = process.env.SHOPIFY_SHOP;
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyHmac(req, raw) {
  const recv = req.headers['x-shopify-hmac-sha256'] || '';
  if (!SECRET || !recv) return false;
  const digest = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const a = Buffer.from(digest); const b = Buffer.from(recv);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
  customersByEmail: `query($q:String!){
    customers(first:1, query:$q){ nodes{ id email } }
  }`,
  customerRetainerFields: `query($id:ID!){
    customer(id:$id){
      id
      metafields(first:25, namespace:"retainer"){
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

// Helpers
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
  // list.single_line_text_field expects a JSON array of strings
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
    value: JSON.stringify({ file_id: fileGid })
  });
};

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readRawBody(req);
  if (!verifyHmac(req, raw)) return res.status(401).send('invalid hmac');

  const order = JSON.parse(raw.toString('utf8'));

  try {
    const orderGid = `gid://shopify/Order/${order.id}`;
    const attrs = pullCartAttributes(order);
    const props = pullLineItemProps(order);

    // Values from checkout (props override attrs)
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

    const j_house = props.intake_household_json || '[]';
    const j_veh   = props.intake_vehicles_json  || '[]';

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
    pushJSON(mfs, orderGid, 'intake_household_json', j_house);
    pushJSON(mfs, orderGid, 'intake_vehicles_json',  j_veh);
    if (v_notes) mfs.push({ namespace:'retainer', ownerId:orderGid, key:'intake_notes', type:'multi_line_text_field', value:String(v_notes) });

    // ---- Copy file references from the Customer to the Order ----
    // Resolve customer GID (REST payload gives numeric id)
    let customerGid = order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : null;
    if (!customerGid && order.email) {
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(order.email.toLowerCase())}` });
      customerGid = found.customers.nodes[0]?.id || null;
    }

    if (customerGid) {
      const data = await gql(Q.customerRetainerFields, { id: customerGid });
      const nodes = data?.customer?.metafields?.nodes || [];

      const mfMap = {};
      for (const n of nodes) mfMap[n.key] = n;

      // file_reference keys on Customer
      const sigRef = mfMap.signature?.reference?.id || null;
      const dlRef  = mfMap.drivers_license?.reference?.id || null;
      const icRef  = mfMap.car_insurance?.reference?.id || null;

      pushFILE(mfs, orderGid, 'signature',       sigRef);
      pushFILE(mfs, orderGid, 'drivers_license', dlRef);
      pushFILE(mfs, orderGid, 'car_insurance',   icRef);

      // If you keep pretty lists on the customer, mirror them to order
      // (keeps email simple — no JSON)
      let hhList = null, vList = null;
      if (mfMap.household_list?.type === 'list.single_line_text_field') {
        try { hhList = JSON.parse(mfMap.household_list.value); } catch(_){}
      }
      if (mfMap.vehicles_list?.type === 'list.single_line_text_field') {
        try { vList = JSON.parse(mfMap.vehicles_list.value); } catch(_){}
      }
      if (Array.isArray(hhList)) pushLIST(mfs, orderGid, 'household_list', hhList);
      if (Array.isArray(vList))  pushLIST(mfs, orderGid, 'vehicles_list',  vList);
    }

    if (mfs.length) {
      const r = await gql(Q.metafieldsSet, { metafields: mfs });
      const errs = r.metafieldsSet?.userErrors || [];
      if (errs.length) console.warn('order metafields userErrors', errs);
    }

    // Update customer's last_* snapshot
    if (customerGid) {
      const cmf = [];
      if (v_plan) cmf.push({ namespace:'retainer', ownerId:customerGid, key:'last_retainer_plan', type:'single_line_text_field', value:String(v_plan) });
      if (v_term) cmf.push({ namespace:'retainer', ownerId:customerGid, key:'last_retainer_term', type:'single_line_text_field', value:String(v_term) });
      if (cmf.length) await gql(Q.metafieldsSet, { metafields: cmf });
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('order-webhook error', e);
    // Keep 200 during dev to avoid retries; switch to 500 when stable.
    res.status(200).send('error');
  }
}
