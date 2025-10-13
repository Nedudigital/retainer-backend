// /api/retainer/order-webhook.js
// HMAC-verified Shopify webhook for orders/create & orders/paid.
// Writes order metafields under namespace "retainer" matching your definitions.
// Removed all bi_limits handling to match UI/backend.

import crypto from 'node:crypto';

const SHOP   = process.env.SHOPIFY_SHOP;
const TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

export const config = { api: { bodyParser: false } };

async function rawBody(req){ const bufs=[]; for await (const c of req) bufs.push(c); return Buffer.concat(bufs); }
function verify(req, raw){
  const sig = req.headers['x-shopify-hmac-sha256'] || '';
  if (!SECRET || !sig) return false;
  const digest = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
  const a = Buffer.from(digest); const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function gql(query, variables){
  const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
    method:'POST',
    headers:{ 'X-Shopify-Access-Token': TOKEN, 'Content-Type':'application/json' },
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
  customerRetainerFiles: `query($id:ID!){
    customer(id:$id){
      id
      metafields(first:25, namespace:"retainer"){
        nodes{
          key
          type
          reference{
            __typename
            ... on MediaImage { id }
            ... on GenericFile { id }
          }
          value
        }
      }
    }
  }`
};

// helpers
const isYMD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s||''));
function pullAttrs(order){ const m={}; for (const na of order.note_attributes||[]) if (na?.name) m[na.name]=na.value; return m; }
function pullProps(order){
  const m={};
  for (const li of order.line_items||[]) for (const p of li.properties||[])
    if (p?.name && p.value!=null && String(p.value).trim()!=='') m[p.name]=p.value;
  return m;
}

// pushers that MATCH YOUR DEFINITIONS
const pushSL = (arr, ownerId, key, val) => { const v=(val??'').toString().trim(); if(v) arr.push({namespace:'retainer', ownerId, key, type:'single_line_text_field', value:v}); };
const pushML = (arr, ownerId, key, val) => { const v=(val??'').toString(); if(v) arr.push({namespace:'retainer', ownerId, key, type:'multi_line_text_field', value:v}); };
const pushDT = (arr, ownerId, key, val) => { const v=(val??'').toString().trim(); if(isYMD(v)) arr.push({namespace:'retainer', ownerId, key, type:'date', value:v}); };
const pushBL = (arr, ownerId, key, tf)   => { if (tf===true || tf===false) arr.push({namespace:'retainer', ownerId, key, type:'boolean', value: tf?'true':'false'}); };
const pushNI = (arr, ownerId, key, n)    => { const v=Number(n); if(Number.isInteger(v)) arr.push({namespace:'retainer', ownerId, key, type:'number_integer', value:String(v)}); };
const pushJSON = (arr, ownerId, key, val) => {
  // your "Intake Vehicles/household" are JSON type
  let s = typeof val==='string' ? val : JSON.stringify(val ?? []);
  try { JSON.parse(s); arr.push({ namespace:'retainer', ownerId, key, type:'json', value:s }); } catch(_){}
};
const pushFILE = (arr, ownerId, key, gid) => {
  if (!gid) return;
  arr.push({ namespace:'retainer', ownerId, key, type:'file_reference', value: JSON.stringify({ file_id: gid }) });
};

export default async function handler(req, res){
  if (req.method==='GET') return res.status(200).send('ok');
  if (req.method!=='POST') return res.status(405).end();

  const raw = await rawBody(req);
  if (!verify(req, raw)) return res.status(401).send('invalid hmac');

  const order = JSON.parse(raw.toString('utf8'));

  try{
    const orderGid = `gid://shopify/Order/${order.id}`;
    const attrs = pullAttrs(order);
    const props = pullProps(order);

    // Values (props override attrs)
    const plan   = props.retainer_plan || attrs.retainer_plan || '';
    const term   = props.retainer_term || attrs.retainer_term || '';
    const sName  = props.signed_name   || attrs.retainer_signed_name || '';
    const sDate  = props.signed_date   || attrs.retainer_signed_date || '';
    const hasBI  = (props.intake_has_bi === 'yes') || (props.has_bi === 'true') || (attrs.retainer_has_bi === 'yes');
    const insurer= props.intake_insurer || props.insurer || '';
    const dob    = props.intake_dob || props.dob || '';
    const cars   = props.intake_cars_count ?? props.cars_count ?? null;
    const notes  = props.intake_notes || '';

    // JSON blobs coming from checkout
    let houseJson = props.intake_household_json || '[]';
    let vehJson   = props.intake_vehicles_json  || '[]';

    // Build pretty SINGLE-LINE strings (joined with " | ")
    const toPrettyHouse = (arr) => (arr||[]).map(h=>[h.name,h.dob,h.relationship].filter(Boolean).join(' — ')).filter(Boolean).join(' | ');
    const toPrettyVeh   = (arr) => (arr||[]).map(v=>[v.year,v.make,v.model].filter(Boolean).join(' ')).filter(Boolean).join(' | ');

    let houseArr = []; let vehArr = [];
    try { houseArr = JSON.parse(houseJson); } catch(_){}
    try { vehArr   = JSON.parse(vehJson);   } catch(_){}

    const mfs = [];
    // core
    pushSL(mfs, orderGid, 'plan', plan);
    pushSL(mfs, orderGid, 'term', term);
    pushBL(mfs, orderGid, 'bi_info', hasBI);               // boolean (BI info)
    pushSL(mfs, orderGid, 'insurer', insurer);
    pushNI(mfs, orderGid, 'cars_count', cars);
    pushDT(mfs, orderGid, 'dob', dob);
    pushSL(mfs, orderGid, 'signed_name', sName);
    pushDT(mfs, orderGid, 'signed_date', sDate);

    // lists as SINGLE LINE TEXT (joined with " | ")
    pushSL(mfs, orderGid, 'household_list', toPrettyHouse(houseArr));
    pushSL(mfs, orderGid, 'vehicles_list',  toPrettyVeh(vehArr));

    // raw JSON (since you also have JSON defs)
    pushJSON(mfs, orderGid, 'intake_household', houseArr);
    pushJSON(mfs, orderGid, 'intake_vehicles',  vehArr);

    if (notes) pushML(mfs, orderGid, 'intake_notes', String(notes));

    // copy FILE references from Customer → Order
    let customerGid = order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : null;
    if (!customerGid && order.email){
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(order.email.toLowerCase())}` });
      customerGid = found.customers.nodes[0]?.id || null;
    }

    if (customerGid){
      const data = await gql(Q.customerRetainerFiles, { id: customerGid });
      const nodes = data?.customer?.metafields?.nodes || [];
      const byKey = Object.fromEntries(nodes.map(n => [n.key, n]));

      const sig = byKey.signature?.reference?.id || null;
      const dl  = byKey["drivers_license"]?.reference?.id || null;
      const ic  = byKey["car_insurance"]?.reference?.id || null;

      pushFILE(mfs, orderGid, 'signature', sig);
      pushFILE(mfs, orderGid, 'drivers_license', dl);
      pushFILE(mfs, orderGid, 'car_insurance', ic);
    }

    if (mfs.length){
      const r = await gql(Q.metafieldsSet, { metafields: mfs });
      const errs = r.metafieldsSet?.userErrors || [];
      if (errs.length) console.warn('order metafields userErrors', errs);
    }

    // update customer's last_* snapshot
    if (customerGid){
      const cmf = [];
      if (plan) pushSL(cmf, customerGid, 'last_retainer_plan', plan);
      if (term) pushSL(cmf, customerGid, 'last_retainer_term', term);
      if (cmf.length) await gql(Q.metafieldsSet, { metafields: cmf });
    }

    res.status(200).send('ok');
  }catch(e){
    console.error('order-webhook error', e);
    // keep 200 during dev to avoid retries; flip to 500 when stable
    res.status(200).send('error');
  }
}
