// Receiving Tracker Edge Function
//
// POST /functions/v1/receiving-tracker   body: { "fn": "<name>", "args": { ... } }
// Headers:
//   Authorization: Bearer <SUPABASE_ANON_KEY>   (gateway check; the anon key is public by design)
//   x-trk-code: shared staff password (pw_access in trk.settings; not needed when unset)
//   x-trk-user: name of the person acting (URL encoded)
// Response: { ok: true, result } | { ok: false, error, code }
//
// Optional secret: TRACKER_ALLOWED_ORIGINS, e.g. https://hobbybee.netlify.app
import postgres from 'npm:postgres@3.4.5';
import { handle } from './core.js';

const allowedOrigins = (Deno.env.get('TRACKER_ALLOWED_ORIGINS') || '*').split(',').map((s) => s.trim()).filter(Boolean);
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 4, prepare: false, idle_timeout: 20, onnotice: () => {} });
const db = {
  transaction: (fn: (tx: unknown) => Promise<unknown>) =>
    sql.begin((tx) => fn({ query: (text: string, params?: unknown[]) => tx.unsafe(text, (params || []) as never[]) }))
};

function cors(origin: string | null) {
  const allow = allowedOrigins.includes('*') ? '*' : (origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || '');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-trk-code, x-trk-user',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function reply(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  if (req.method !== 'POST') return reply({ ok: false, error: 'Method not allowed' }, 405, origin);

  let body: { fn?: string; args?: unknown };
  try { body = await req.json(); } catch { return reply({ ok: false, error: 'Invalid JSON body.' }, 400, origin); }
  const fn = String(body.fn || '');
  let user = '';
  try { user = decodeURIComponent(req.headers.get('x-trk-user') || ''); } catch { user = ''; }

  try {
    const result = await handle(db, fn, body.args || {}, { code: req.headers.get('x-trk-code') || '', user });
    return reply({ ok: true, result }, 200, origin);
  } catch (error) {
    const err = error as { message?: string; code?: string; name?: string };
    if (err && err.name === 'UserError') return reply({ ok: false, error: err.message, code: err.code || '' }, 200, origin);
    console.error(fn, error);
    return reply({ ok: false, error: 'Server error: ' + (err && err.message ? err.message : String(error)) }, 500, origin);
  }
});
