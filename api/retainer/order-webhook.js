// Receives orders/create or orders/paid webhook
// - Verifies HMAC
// - Writes order metafields (namespace: retainer)
// - Updates customer metafields (last_retainer_*)

import crypto from 'node:crypto';

const SHOP  = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SECRET= process.env.SHOPIFY_WEBHOOK_SECRET;

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyHmac(req, rawBody) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader || !SECRET) return false;
  const digest = crypto
    .createHmac('sha256', SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
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
  metafieldsSet: `
    mutation($metafields:[MetafieldsSetInput!]!){
      metafieldsSet(metafields:$metafields){
        metafields{ ownerType namespace key type }
        userErrors{ field message }
      }
    }`,
  customerUpdate: `
    mutation($id:ID!, $input:CustomerInput!){
      customerUpdate(id:$id, input:$input){
        customer{ id }
        userErrors{ field message }
      }
    }`,
  customersByEmail: `
    query($q:String!){
      customers(first:1, query:$q){ nodes{ id email } }
    }`
};

function pullCartAttributes(order) {
  // cart attributes arrive as order.note_attributes: [{name, value}, ...]
  const map = {};
  for (const na of order.note_attributes || []) {
    map[na.name] = na.value;
  }
  return map;
}

function pullLineItemProps(order) {
  const props = {};
  for (const li of order.line_items || []) {
    for (const p of li.properties || []) {
      // only copy non-empty values
      if (p && p.name && p.value != null && String(p.value).trim() !== '') {
        props[p.name] = p.value;
      }
    }
  }
  return props;
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok'); // health
  if (req.method !== 'POST') return res.status(405).end();

  // 1) verify HMAC
  const raw = await readRawBody(req);
  if (!verifyHmac(req, raw)) {
    return res.status(401).send('invalid hmac');
  }

  // 2) parse webhook payload
  const order = JSON.parse(raw.toString('utf8'));

  try {
    // Sources of data we set earlier in the theme:
    // - Cart attributes: retainer_plan, retainer_term, retainer_signature_url, etc.
    // - Line item properties: intake_* fields, intake_household_json, intake_vehicles_json, etc.
    const attrs = pullCartAttributes(order);
    const liProps = pullLineItemProps(order);

    // Order GID for GraphQL ownerId
    const orderGid = `gid://shopify/Order/${order.id}`;

    // Prepare order metafields (namespace: retainer)
    const omf = [
      { key:'retainer_plan',  type:'single_line_text_field', value: attrs.retainer_plan || liProps.retainer_plan || '' },
      { key:'retainer_term',  type:'single_line_text_field', value: attrs.retainer_term || liProps.retainer_term || '' },
      { key:'signature_url',  type:'single_line_text_field', value: attrs.retainer_signature_url || liProps.signature_url || '' },
      { key:'signed_name',    type:'single_line_text_field', value: attrs.retainer_signed_name || liProps.signed_name || '' },
      { key:'signed_date',    type:'date',                   value: attrs.retainer_signed_date || liProps.signed_date || '' },
      { key:'intake_household_json', type:'json', value: liProps.intake_household_json || '[]' },
      { key:'intake_vehicles_json',  type:'json', value: liProps.intake_vehicles_json  || '[]' },
      { key:'intake_notes',   type:'multi_line_text_field',  value: liProps.intake_notes || '' },
      { key:'insurer',        type:'single_line_text_field', value: liProps.intake_insurer || liProps.insurer || '' },
      { key:'bi_limits',      type:'single_line_text_field', value: liProps.intake_bi_limits || liProps.bi_limits || '' },
      { key:'has_bi',         type:'boolean',                value: (liProps.intake_has_bi === 'yes' || liProps.has_bi === 'true') ? 'true' : 'false' },
      { key:'dob',            type:'date',                   value: liProps.intake_dob || liProps.dob || '' },
      { key:'cars_count',     type:'number_integer',         value: String(Number(liProps.intake_cars_count || liProps.cars_count || 0)) }
    ].map(m => ({ ...m, namespace:'retainer', ownerId: orderGid }));

    await gql(Q.metafieldsSet, { metafields: omf });

    // 3) Update customer metafields (last_retainer_*) by email match if present
    let customerId = null;
    if (order.customer && order.customer.id) {
      customerId = `gid://shopify/Customer/${order.customer.id}`;
    } else if (order.email) {
      const found = await gql(Q.customersByEmail, { q: `email:${JSON.stringify(order.email)}` });
      customerId = found.customers.nodes[0]?.id || null;
    }

    if (customerId) {
      const cmf = [
        { key:'last_retainer_plan', type:'single_line_text_field', value: attrs.retainer_plan || liProps.retainer_plan || '' },
        { key:'last_retainer_term', type:'single_line_text_field', value: attrs.retainer_term || liProps.retainer_term || '' }
      ].map(m => ({ ...m, namespace:'retainer', ownerId: customerId }));
      await gql(Q.metafieldsSet, { metafields: cmf });
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('order-webhook error', e);
    res.status(500).send('error');
  }
}
