// /api/quote — publieke, klant-veilige weergave + online akkoord van één offerte.
//
// Publiceren (door de tool):   POST  {ws, archiveId, snapshot, lang, projectName}      -> { id }
// Bekijken   (door de klant):  GET   ?id=<id>   -> { snapshot, lang, projectName, status, acceptedBy, acceptedAt }
// Accorderen (door de klant):  POST  ?id=<id>   {action:'accept', name, note}           -> { ok, status }
//
// De `snapshot` is de al KLANT-VEILIGE tokenset (mapQuoteToTokens): lump-sum kosten, geen
// marges/kostprijzen/interne links. De workspace-token (ws) en archiveId worden server-side
// bewaard en NOOIT naar de klant teruggegeven. Bekijken logt een view; accorderen zet de
// offerte in het workspace-archief automatisch op 'geaccepteerd' (dezelfde Upstash-opslag).
//
// Env (Vercel <-> Upstash; beide naamschema's):
//   KV_REST_API_URL / UPSTASH_REDIS_REST_URL, KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 365 * 2;

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
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();

async function getRec(id) {
  const v = await redis(['GET', 'q:' + id]);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
const putRec = (id, rec) => redis(['SET', 'q:' + id, JSON.stringify(rec), 'EX', TTL]);

// Patch the workspace archive entry (status / changelog) so the tool picks it up on next sync.
async function patchArchive(ws, archiveId, mutate) {
  if (!ws || !archiveId) return;
  let arr;
  try { arr = JSON.parse((await redis(['GET', 'arch:' + ws])) || '[]'); } catch (e) { return; }
  if (!Array.isArray(arr)) return;
  const idx = arr.findIndex((e) => e && e.id === archiveId);
  if (idx < 0) return;
  mutate(arr[idx]);
  await redis(['SET', 'arch:' + ws, JSON.stringify(arr), 'EX', TTL]);
}

// Stuur een e-mailmelding bij akkoord. Achter env-vars; stil overslaan als niet geconfigureerd,
// zodat akkoord nooit faalt door mailproblemen.
//   RESEND_API_KEY  — API key van resend.com
//   NOTIFY_EMAIL    — ontvanger (bijv. erik@teamteal.nl)
//   NOTIFY_FROM     — afzender op een geverifieerd domein (default onboarding@resend.dev)
async function notifyEmail(rec) {
  const key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return;
  const from = process.env.NOTIFY_FROM || 'TEAL Offerte <onboarding@resend.dev>';
  const proj = rec.projectName || '(zonder naam)';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to,
        subject: '✅ Offerte getekend: ' + proj + ' — ' + rec.acceptedBy,
        text: rec.acceptedBy + ' heeft de offerte "' + proj + '" online geaccepteerd op ' +
          rec.acceptedAt + '.' + (rec.note ? ('\n\nOpmerking van de klant:\n' + rec.note) : ''),
      }),
    });
  } catch (e) { /* mail mag nooit het akkoord blokkeren */ }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const id = String((req.query && req.query.id) || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);

    if (req.method === 'POST' && !id) {
      // Publiceren
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const ws = cleanWs(body && body.ws);
      if (ws.length < 8) return res.status(400).json({ error: 'bad-ws' });
      if (!body || !body.snapshot || typeof body.snapshot !== 'object') return res.status(400).json({ error: 'bad-snapshot' });
      const newId = genId();
      const vd = Math.max(1, Math.min(3650, parseInt(body.validityDays) || 30));
      const rec = {
        ws, archiveId: body.archiveId || null, snapshot: body.snapshot,
        lang: body.lang === 'en' ? 'en' : 'nl', projectName: body.projectName || '',
        status: 'open', createdAt: nowIso(), views: 0, lastView: null, lastViewDay: null,
        validityDays: vd, expiresAt: new Date(Date.now() + vd * 86400000).toISOString(),
        acceptedBy: null, acceptedAt: null, note: null,
      };
      const payload = JSON.stringify(rec);
      if (payload.length > 4000000) return res.status(413).json({ error: 'too-large' });
      await putRec(newId, rec);
      return res.status(200).json({ id: newId });
    }

    if (req.method === 'GET' && id) {
      // Bekijken (klant) — nooit ws/archiveId teruggeven
      const rec = await getRec(id);
      if (!rec) return res.status(404).json({ error: 'not-found' });
      const today = nowIso().slice(0, 10);
      rec.views = (rec.views || 0) + 1; rec.lastView = nowIso();
      const firstToday = rec.lastViewDay !== today;
      rec.lastViewDay = today;
      await putRec(id, rec);
      if (firstToday && rec.status === 'open') {
        // Log 'bekeken' één keer per dag in het archief (geen statuswijziging).
        await patchArchive(rec.ws, rec.archiveId, (e) => {
          if (!Array.isArray(e.changelog)) e.changelog = [];
          e.changelog.push({ action: 'bekeken door klant', date: nowIso() });
          e.updatedAt = nowIso();
        });
      }
      const isExpired = rec.status !== 'accepted' && rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime();
      return res.status(200).json({
        snapshot: rec.snapshot, lang: rec.lang, projectName: rec.projectName,
        status: rec.status, acceptedBy: rec.acceptedBy, acceptedAt: rec.acceptedAt,
        expiresAt: rec.expiresAt || null, expired: !!isExpired,
      });
    }

    if (req.method === 'POST' && id) {
      // Accorderen (klant)
      let body = req.body; if (typeof body === 'string') body = JSON.parse(body);
      const rec = await getRec(id);
      if (!rec) return res.status(404).json({ error: 'not-found' });
      const action = body && body.action;
      if (action === 'accept') {
        const name = String((body && body.name) || '').trim().slice(0, 120);
        if (!name) return res.status(400).json({ error: 'name-required' });
        if (rec.status !== 'accepted' && rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()) return res.status(403).json({ error: 'expired' });
        if (rec.status !== 'accepted') {
          rec.status = 'accepted'; rec.acceptedBy = name; rec.acceptedAt = nowIso();
          rec.note = String((body && body.note) || '').slice(0, 1000) || null;
          await putRec(id, rec);
          const when = rec.acceptedAt;
          await patchArchive(rec.ws, rec.archiveId, (e) => {
            e.status = 'geaccepteerd'; e.statusAt = when; e.updatedAt = when;
            if (!Array.isArray(e.changelog)) e.changelog = [];
            e.changelog.push({ action: 'geaccepteerd door ' + name, date: when });
          });
          await notifyEmail(rec);
        }
        return res.status(200).json({ ok: true, status: 'accepted', acceptedBy: rec.acceptedBy, acceptedAt: rec.acceptedAt });
      }
      return res.status(400).json({ error: 'bad-action' });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method-not-allowed' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(msg === 'storage-not-configured' ? 501 : 500).json({ error: msg });
  }
};
