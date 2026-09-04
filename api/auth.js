// /api/auth — Google Sign-In voor de Offerte Tool.
//
// Slapend tot GOOGLE_CLIENT_ID in de omgeving staat: zolang die ontbreekt geeft
// ?action=config geen client-id terug en gedraagt de tool zich als voorheen
// (per-browser ws-token). Zodra de client-id gezet is, vereist de editor login.
//
//   GET  ?action=config                 -> { clientId }            (publiek)
//   GET  ?action=me      (cookie sid)   -> { authed, email, ws }
//   POST { action:'verify', credential } -> { email, ws } + Set-Cookie sid
//   POST { action:'logout' }             -> { ok } + cookie gewist
//
// Sessies staan in Upstash (sess:<sid>), 30 dagen. Het account↔werkruimte-paar
// staat in acct:<email>; voor het primaire account wordt PRIMARY_WS als
// startwaarde gebruikt zodat de bestaande offertes meteen zichtbaar zijn.
//
// Env: KV_REST_API_URL/UPSTASH_REDIS_REST_URL + _TOKEN (Upstash),
//      GOOGLE_CLIENT_ID (verplicht om login te activeren),
//      AUTH_ALLOWED_EMAILS (komma/spatie-lijst, default erik@teamteal.nl),
//      PRIMARY_EMAIL (default erik@teamteal.nl), PRIMARY_WS (bestaande ws).

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SESS_TTL = 60 * 60 * 24 * 30; // 30 dagen

async function redis(cmd) {
  if (!BASE || !TOKEN) throw new Error('storage-not-configured');
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const mintWs = () => (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 22);
const mintSid = () => (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 32);

function allowedEmails() {
  return (process.env.AUTH_ALLOWED_EMAILS || 'erik@teamteal.nl').toLowerCase().split(/[,\s]+/).filter(Boolean);
}
function isAllowed(email) {
  return allowedEmails().includes(String(email || '').toLowerCase());
}
function primaryEmail() {
  return (process.env.PRIMARY_EMAIL || 'erik@teamteal.nl').toLowerCase();
}

function parseCookies(req) {
  const out = {};
  const h = req.headers && req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

// Verifieer het Google ID-token via de tokeninfo-endpoint (geen dependency).
async function verifyGoogleIdToken(idToken) {
  if (!idToken) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!r.ok) return null;
  const c = await r.json();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || c.aud !== clientId) return null;
  if (!(c.email_verified === true || String(c.email_verified) === 'true')) return null;
  if (c.exp && nowSec() > Number(c.exp)) return null;
  if (!c.email) return null;
  return c;
}

// Werkruimte voor dit account: bestaand paar, anders startwaarde (PRIMARY_WS voor
// het primaire account) en persist. Zo blijven bestaande offertes gekoppeld.
async function resolveWs(email) {
  const key = 'acct:' + String(email).toLowerCase();
  const existing = await redis(['GET', key]);
  if (existing) return existing;
  const seed = (String(email).toLowerCase() === primaryEmail() && process.env.PRIMARY_WS) ? process.env.PRIMARY_WS : mintWs();
  await redis(['SET', key, seed]);
  return seed;
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESS_TTL}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const action = (req.method === 'POST' ? body.action : q.action) || '';

    if (req.method === 'GET' && action === 'config') {
      return res.status(200).json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
    }

    if (req.method === 'GET' && action === 'me') {
      const sid = parseCookies(req).sid;
      if (!sid) return res.status(200).json({ authed: false });
      const raw = await redis(['GET', 'sess:' + sid]);
      if (!raw) return res.status(200).json({ authed: false });
      let sess; try { sess = JSON.parse(raw); } catch (e) { sess = null; }
      if (!sess || !sess.email || !sess.ws) return res.status(200).json({ authed: false });
      return res.status(200).json({ authed: true, email: sess.email, ws: sess.ws });
    }

    if (req.method === 'POST' && action === 'verify') {
      if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'login-not-configured' });
      const claims = await verifyGoogleIdToken(body.credential);
      if (!claims) return res.status(401).json({ error: 'bad-token' });
      const email = String(claims.email).toLowerCase();
      if (!isAllowed(email)) return res.status(403).json({ error: 'not-allowed' });
      const ws = await resolveWs(email);
      const sid = mintSid();
      await redis(['SET', 'sess:' + sid, JSON.stringify({ email, ws, at: nowSec() }), 'EX', SESS_TTL]);
      setSessionCookie(res, sid);
      return res.status(200).json({ email, ws });
    }

    if (req.method === 'POST' && action === 'logout') {
      const sid = parseCookies(req).sid;
      if (sid) { try { await redis(['DEL', 'sess:' + sid]); } catch (e) { /* best effort */ } }
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(400).json({ error: 'bad-action' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(msg === 'storage-not-configured' ? 501 : 500).json({ error: msg });
  }
};
