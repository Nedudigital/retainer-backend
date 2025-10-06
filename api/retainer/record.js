import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth:{ persistSession:false } });

function cors(res, origin) {
    const allowList = (process.env.ALLOWED_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
  
    // allow if in list; otherwise mirror origin if present (no credentials used)
    const allow = origin && (allowList.length === 0 || allowList.includes(origin));
  
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (origin && allow) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
      // server-to-server or curl — safest default
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }
  

function keyPath(email){ const safe=email.toLowerCase().replace(/[^a-z0-9._-]+/g,'-'); return `signatures/${safe}/${Date.now()}.png`; }

async function saveSignature(signatureDataUrl, email){
  if (!signatureDataUrl || !signatureDataUrl.startsWith('data:image/png')) return { url:null, error:null };
  const base64 = signatureDataUrl.split(',')[1];
  const buf = Buffer.from(base64,'base64');
  const path = keyPath(email);
  const { error: upErr } = await supabase.storage.from('retainer-signatures').upload(path, buf, { contentType:'image/png', upsert:true });
  if (upErr) return { url:null, error:`upload:${upErr.message}` };
  const { data } = supabase.storage.from('retainer-signatures').getPublicUrl(path);
  return { url: data.publicUrl || null, error:null };
}

export default async function handler(req, res){
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try{
    if (req.method === 'GET'){
      const email = String(req.query.email||'').trim().toLowerCase();
      if (!email) return res.status(400).json({ ok:false, error:'missing email' });
      const { data, error } = await supabase.from('customer_intakes').select('*').eq('email', email).maybeSingle();
      if (error) return res.status(200).json({ ok:false, error:error.message });
      return res.status(200).json({ ok:true, record:data || null });
    }

    if (req.method === 'PUT'){
      const p = req.body || {};
      const email = String(p.email||'').trim().toLowerCase();
      if (!email) return res.status(400).json({ ok:false, error:'missing email' });

      let signature_url = p.signature_url || null;
      if (!signature_url && p.signature_data_url){
        const { url, error } = await saveSignature(p.signature_data_url, email);
        if (!error) signature_url = url; else console.warn('signature upload failed:', error);
      }

      const record = {
        email,
        full_name:   p.full_name ?? null,
        first_name:  p.first_name ?? null,
        last_name:   p.last_name ?? null,
        dob:         p.dob || null,
        phone:       p.phone ?? null,
        home_address:p.home_address ?? null,
        insurer:     p.insurer ?? null,
        bi_limits:   p.bi_limits ?? null,
        has_bi:      !!p.has_bi,
        cars_count:  Number.isFinite(+p.cars_count) ? +p.cars_count : 0,
        household:   Array.isArray(p.household) ? p.household : [],
        vehicles:    Array.isArray(p.vehicles) ? p.vehicles : [],
        notes:       p.notes ?? null,
        signature_url,
        updated_at:  new Date().toISOString()
      };

      const { data, error } = await supabase.from('customer_intakes')
        .upsert(record, { onConflict:'email' })
        .select().maybeSingle();

      if (error) return res.status(200).json({ ok:false, error:error.message });
      return res.status(200).json({ ok:true, record:data });
    }

    return res.status(405).json({ ok:false, error:'method not allowed' });
  }catch(e){
    console.error('record handler error', e);
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
