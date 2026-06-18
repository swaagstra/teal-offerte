// /api/share — short, private share links for the TEAL Planner.
// Stores a planning's JSON under a short id in Upstash Redis (REST API).
// POST  body=<state JSON>           -> { id }
// GET   ?id=<id>                    -> <state JSON>
//
// Env vars (provided by the Vercel <-> Upstash integration; both naming
// schemes are accepted so it works however the store was connected):
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

function makeId(n = 7) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// One year, in seconds.
const TTL = 60 * 60 * 24 * 365;

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      let body = req.body;
      if (body && typeof body !== 'string') body = JSON.stringify(body);
      if (!body || body.length < 2) return res.status(400).json({ error: 'empty' });
      if (body.length > 3000000) return res.status(413).json({ error: 'too-large' });

      let id;
      for (let attempt = 0; attempt < 6; attempt++) {
        id = makeId(7);
        const exists = await redis(['EXISTS', 'share:' + id]);
        if (!exists) break;
      }
      await redis(['SET', 'share:' + id, body, 'EX', TTL]);
      return res.status(200).json({ id });
    }

    if (req.method === 'GET') {
      const id = String((req.query && req.query.id) || '').replace(/[^a-z0-9]/gi, '');
      if (!id) return res.status(400).json({ error: 'no-id' });
      const v = await redis(['GET', 'share:' + id]);
      if (!v) return res.status(404).json({ error: 'not-found' });
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(v);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(msg === 'storage-not-configured' ? 501 : 500).json({ error: msg });
  }
};
