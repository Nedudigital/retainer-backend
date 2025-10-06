// API: PUT to create/update a record in Supabase, GET to read it back.
// TEMP: permissive CORS for storefront testing. Tighten once verified.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role (bypasses RLS)
const TABLE         = process.env.RETAINER_TABLE || 'retainer_records';
const SIG_BUCKET    = process.env.SIGNATURES_BUCKET || 'signatures';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- CORS (debug-permissive) ----------
function cors(res, origin) {
  // Echo whatever origin called us so preflight passes from your theme, preview, etc.
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

// ---------- Helpers ----------
function isEmail(s){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').toLowerCase()); }
function nowIso(){ return new Date().toISOString(); }

// Upload a data URL PNG to Supabase Storage → returns { path, publicUrl, error }
async function uploadSignature(dataUrl, email){
  if (!dataUrl || !dataUrl.startsWith('data:image/png')) {
    return { path:null, publicUrl:null, error:'signature_data_url missing/invalid' };
  }
  const base64 = dataUrl.split(',')[1];
  const buf = Buffer.from(base64, 'base64');
  const safeEmail = String(email).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const path = `${safeEmail}/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;

  const { error: upErr } = await supabase
    .storage
    .from(SIG_BUCKET)
    .upload(path, buf, { contentType: 'image/png', upsert: false });

  if (upErr) return { path:null, publicUrl:null, error: upErr.message };

  const { data: pub } = supabase.storage.from(SIG_BUCKET).getPublicUrl(path);
  return { path, publicUrl: pub?.publicUrl || null, error:null };
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'PUT') {
      const p = req.body || {};
      const email = String(p.email || '').trim().toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ ok:false, error:'invalid email' });

      // optional signature upload
      let sig = { attempted: !!p.signature_data_url, uploaded:false, path:null, publicUrl:null, error:null };
      if (p.signature_data_url) {
        const up = await uploadSignature(p.signature_data_url, email);
        sig = { attempted:true, uploaded: !!up.path, path: up.path, publicUrl: up.publicUrl, error: up.error };
      }

      // upsert record
      const row = {
        email,
        full_name: p.full_name || null,
        dob: p.dob || null,
        insurer: p.insurer || null,
        bi_limits: p.bi_limits || null,
        has_bi: !!p.has_bi,
        cars_count: Number.isFinite(p.cars_count) ? p.cars_count : Number(p.cars_count || 0),
        household: Array.isArray(p.household) ? p.household : [],
        vehicles: Array.isArray(p.vehicles) ? p.vehicles : [],
        notes: p.notes || null,
        signature_url: sig.publicUrl || null,
        signature_path: sig.path || null,
        updated_at: nowIso()
      };

      const { error: upsertErr } = await supabase
        .from(TABLE)
        .upsert(row, { onConflict: 'email' });

      if (upsertErr) return res.status(200).json({ ok:false, error: upsertErr.message, sig });

      return res.status(200).json({ ok:true, row, sig });
    }

    if (req.method === 'GET') {
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ ok:false, error:'invalid email' });

      const { data, error } = await supabase
        .from(TABLE)
        .select('*')
        .eq('email', email)
        .maybeSingle();

      if (error) return res.status(200).json({ ok:false, error: error.message });
      return res.status(200).json({ ok:true, record: data || null });
    }

    return res.status(405).end();
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
