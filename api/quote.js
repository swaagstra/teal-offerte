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

// Bij publiceren kan de tool de Algemene Voorwaarden (PDF, base64) meesturen. Die zetten we op
// Vercel Blob (publiek, content-adres) zodat de online klant-weergave er een link naar kan tonen
// en de klant-PDF hem kan bijvoegen. Best-effort: zonder Blob-token → geen avUrl.
const { createHash } = require('node:crypto');
let _put;
async function getPut() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  if (_put === undefined) { try { _put = (await import('@vercel/blob')).put; } catch (e) { _put = null; } }
  return _put;
}
async function offloadAV(b64) {
  const put = await getPut();
  if (!put || !b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const { url } = await put('quotes/av/' + hash + '.pdf', buf, {
      access: 'public', contentType: 'application/pdf', addRandomSuffix: false, allowOverwrite: true,
    });
    return url;
  } catch (e) { return null; }
}

// Stuur e-mailkopieën bij akkoord via Google Workspace (Gmail API, verstuurd vanaf je eigen
// adres). Achter env-vars; stil overslaan als niet geconfigureerd, zodat akkoord nooit faalt.
//   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN — OAuth2 (scope gmail.send)
//   NOTIFY_EMAIL  — interne ontvanger (bijv. erik@teamteal.nl); ook de afzender tenzij NOTIFY_FROM gezet
async function gmailAccessToken() {
  const cid = process.env.GMAIL_CLIENT_ID, csec = process.env.GMAIL_CLIENT_SECRET, rt = process.env.GMAIL_REFRESH_TOKEN;
  if (!cid || !csec || !rt) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  return j.access_token || null;
}
// Verstuur één bericht via de Gmail API, optioneel met een PDF-bijlage (base64).
async function sendGmail(token, from, to, subject, text, pdfB64, filename) {
  const subjLine = 'Subject: =?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
  const fn = String(filename || 'offerte.pdf').replace(/[\r\n"]/g, '');
  let raw;
  if (pdfB64) {
    const boundary = 'b' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    raw = 'From: ' + from + '\r\nTo: ' + to + '\r\n' + subjLine + '\r\nMIME-Version: 1.0\r\n' +
      'Content-Type: multipart/mixed; boundary="' + boundary + '"\r\n\r\n' +
      '--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + text + '\r\n\r\n' +
      '--' + boundary + '\r\nContent-Type: application/pdf; name="' + fn + '"\r\n' +
      'Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="' + fn + '"\r\n\r\n' +
      pdfB64.replace(/(.{76})/g, '$1\r\n') + '\r\n--' + boundary + '--';
  } else {
    raw = 'From: ' + from + '\r\nTo: ' + to + '\r\n' + subjLine +
      '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + text;
  }
  const b64 = Buffer.from(raw, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64 }),
  });
}

// Stuur bij akkoord een kopie naar de klant (het opgegeven e-mailadres) én een interne melding.
// pdfB64 (indien meegestuurd door de browser) gaat als bijlage mee. Nooit blokkerend.
async function sendCopies(rec, pdfB64, filename) {
  try {
    const token = await gmailAccessToken();
    if (!token) return;
    const from = process.env.NOTIFY_FROM || process.env.NOTIFY_EMAIL;
    if (!from) return;
    const NL = (rec.lang || 'nl') !== 'en';
    const proj = rec.projectName || (NL ? 'onze offerte' : 'our quotation');
    if (rec.acceptedEmail) {
      const subj = (NL ? 'Je getekende offerte: ' : 'Your signed quotation: ') + proj;
      const body = NL
        ? 'Beste ' + rec.acceptedBy + ',\n\nBedankt voor je akkoord op de offerte voor ' + proj + '. ' +
          (pdfB64 ? 'In de bijlage vind je een kopie van de getekende offerte.' : 'Je kunt de getekende offerte online bekijken.') +
          '\n\nMet vriendelijke groet,\nTEAL\nteamteal.nl'
        : 'Dear ' + rec.acceptedBy + ',\n\nThank you for accepting the quotation for ' + proj + '. ' +
          (pdfB64 ? 'Attached you will find a copy of the signed quotation.' : 'You can view the signed quotation online.') +
          '\n\nKind regards,\nTEAL\nteamteal.nl';
      await sendGmail(token, from, rec.acceptedEmail, subj, body, pdfB64, filename);
    }
    if (process.env.NOTIFY_EMAIL) {
      const subj = '✅ Offerte getekend: ' + proj + ' — ' + rec.acceptedBy;
      const body = rec.acceptedBy + ' (' + (rec.acceptedEmail || 'geen e-mail') + ') heeft "' + proj +
        '" online geaccepteerd op ' + rec.acceptedAt + '.' + (rec.note ? ('\n\nOpmerking van de klant:\n' + rec.note) : '');
      await sendGmail(token, from, process.env.NOTIFY_EMAIL, subj, body, pdfB64, filename);
    }
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
      const avUrl = (body.av && typeof body.av === 'string') ? await offloadAV(body.av) : null;
      const rec = {
        ws, archiveId: body.archiveId || null, snapshot: body.snapshot,
        lang: body.lang === 'en' ? 'en' : 'nl', projectName: body.projectName || '',
        status: 'open', createdAt: nowIso(), views: 0, lastView: null, lastViewDay: null,
        validityDays: vd, expiresAt: new Date(Date.now() + vd * 86400000).toISOString(),
        avUrl, acceptedBy: null, acceptedAt: null, acceptedEmail: null, note: null,
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
        acceptedEmail: !!rec.acceptedEmail, avUrl: rec.avUrl || null,
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
        const email = String((body && body.email) || '').trim().slice(0, 160);
        const pdf = (body && typeof body.pdf === 'string' && body.pdf.length < 6000000) ? body.pdf : null;
        const filename = String((body && body.filename) || 'offerte.pdf').replace(/[\r\n"]/g, '').slice(0, 120);
        if (rec.status !== 'accepted' && rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()) return res.status(403).json({ error: 'expired' });
        if (rec.status !== 'accepted') {
          rec.status = 'accepted'; rec.acceptedBy = name; rec.acceptedAt = nowIso();
          rec.acceptedEmail = email || null;
          rec.note = String((body && body.note) || '').slice(0, 1000) || null;
          await putRec(id, rec);
          const when = rec.acceptedAt;
          await patchArchive(rec.ws, rec.archiveId, (e) => {
            e.status = 'geaccepteerd'; e.statusAt = when; e.updatedAt = when;
            if (!Array.isArray(e.changelog)) e.changelog = [];
            e.changelog.push({ action: 'geaccepteerd door ' + name, date: when });
          });
          await sendCopies(rec, pdf, filename);
        }
        return res.status(200).json({ ok: true, status: 'accepted', acceptedBy: rec.acceptedBy, acceptedAt: rec.acceptedAt, acceptedEmail: !!rec.acceptedEmail });
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
