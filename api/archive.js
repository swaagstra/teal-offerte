// /api/archive — cloud backup of the full quotation archive for one workspace.
// Stores the whole archive array under a per-workspace key in Upstash Redis.
// POST  body={ ws, archive }        -> { ok: true }
// GET   ?ws=<workspaceId>           -> <archive JSON array>  (or [] if none)
//
// The workspace id is an unguessable token kept in the browser (and a private
// ?ws= link). Same security posture as /api/share: no auth, just hard-to-guess
// keys. Keep your workspace link private.
//
// Env vars (Vercel <-> Upstash integration; both naming schemes accepted):
//   KV_REST_API_URL   / UPSTASH_REDIS_REST_URL
//   KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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

const cleanWs = (v) => String(v || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);

// Two years, in seconds.
const TTL = 60 * 60 * 24 * 365 * 2;

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'bad-json' }); }
      }
      const ws = cleanWs(body && body.ws);
      if (ws.length < 8) return res.status(400).json({ error: 'bad-ws' });
      const archive = body && body.archive;
      if (!Array.isArray(archive)) return res.status(400).json({ error: 'bad-archive' });
      const payload = JSON.stringify(archive);
      if (payload.length > 5000000) return res.status(413).json({ error: 'too-large' });
      await redis(['SET', 'arch:' + ws, payload, 'EX', TTL]);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const ws = cleanWs(req.query && req.query.ws);
      if (ws.length < 8) return res.status(400).json({ error: 'bad-ws' });
      const v = await redis(['GET', 'arch:' + ws]);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(v || '[]');
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(msg === 'storage-not-configured' ? 501 : 500).json({ error: msg });
  }
};
