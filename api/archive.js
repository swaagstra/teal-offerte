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

// --- Image offload to Vercel Blob -------------------------------------------
// The tool posts the whole archive on every save. Before storing, we walk each
// entry and move any embedded base64 image (data:image/...) to Vercel Blob,
// leaving only its https URL behind — same content-addressed path scheme as the
// MCP server, so re-posting the same bytes overwrites rather than duplicates.
// Best-effort: without a Blob token, or on any upload failure, the data: URL is
// kept and the save still succeeds.
const { createHash } = require('node:crypto');

const DATA_IMG = /^data:image\/([a-zA-Z0-9.+-]+);base64,/;

function extFromMime(mime) {
  const t = String(mime).toLowerCase();
  if (t === 'jpeg' || t === 'jpg') return 'jpg';
  if (t === 'svg+xml') return 'svg';
  return t.replace(/[^a-z0-9]/g, '') || 'png';
}

// Lazily resolve @vercel/blob's put() (ESM) from this CommonJS module, or null
// when the package or the write token is unavailable.
let _put;
async function getPut() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  if (_put === undefined) {
    try { _put = (await import('@vercel/blob')).put; }
    catch (e) { _put = null; }
  }
  return _put;
}

// Recursively walk `node`, replacing every data:image string with its Blob
// https-URL (mutates in place). Only touches data: strings; existing https URLs
// are left untouched, so already-migrated quotes stay put.
async function offloadImages(node, archiveId, put, stats) {
  const handle = async (container, key, value) => {
    if (typeof value === 'string' && DATA_IMG.test(value)) {
      const m = DATA_IMG.exec(value);
      const mime = m[1];
      const buf = Buffer.from(value.slice(m[0].length), 'base64');
      const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
      const path = `quotes/${archiveId}/${hash}.${extFromMime(mime)}`;
      try {
        const { url } = await put(path, buf, {
          access: 'public',
          contentType: `image/${mime}`,
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        container[key] = url;
        stats.moved += 1;
      } catch (e) {
        stats.failed += 1;
      }
    } else if (value && typeof value === 'object') {
      await offloadImages(value, archiveId, put, stats);
    }
  };
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) await handle(node, i, node[i]);
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) await handle(node, k, node[k]);
  }
  return stats;
}

// Offload images across a whole archive array, in place. Entries without an id
// are left as-is (no stable Blob path). Never throws.
async function offloadArchive(archive) {
  const put = await getPut();
  if (!put) return { moved: 0, failed: 0, skipped: true };
  const stats = { moved: 0, failed: 0 };
  for (const entry of archive) {
    if (entry && entry.id && entry.data && typeof entry.data === 'object') {
      await offloadImages(entry.data, String(entry.id), put, stats);
    }
  }
  return stats;
}

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
      // Move any embedded base64 images to Blob before storing (best-effort, never throws).
      await offloadArchive(archive);
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
