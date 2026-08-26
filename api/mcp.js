// /api/mcp — remote MCP server voor de TEAL Offerte Tool.
//
// Geeft Claude (claude.ai / Cowork / Claude Code, via een custom connector) een
// direct lees/schrijf-pad naar het offerte-archief van één workspace. Praat met
// dezelfde Upstash-opslag als /api/archive, dus wat je hier schrijft verschijnt
// vanzelf in de tool (die merget bij laden op updatedAt).
//
// Transport: stateless Streamable HTTP (JSON-RPC 2.0 over POST → application/json).
//
// Beveiliging: de workspace-token ÍS de sleutel (net als de ?ws=-deellink). Geef
// de connector-URL met ?ws=<token> — of zet env TEAL_OFFERTE_WS. Hou de URL privé.
//
// Env (al aanwezig via de Vercel<->Upstash-integratie; beide naamschema's):
//   KV_REST_API_URL   / UPSTASH_REDIS_REST_URL
//   KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 365 * 2; // 2 jaar, zelfde als /api/archive
const SERVER_INFO = { name: 'teal-offerte', version: '1.0.0' };
const PROTOCOL_FALLBACK = '2025-06-18';

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
async function getArchive(ws) {
  const v = await redis(['GET', 'arch:' + ws]);
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
async function setArchive(ws, arr) {
  const payload = JSON.stringify(arr);
  if (payload.length > 5000000) throw new Error('too-large');
  await redis(['SET', 'arch:' + ws, payload, 'EX', TTL]);
}
const nowIso = () => new Date().toISOString();
const b36 = (n) => n.toString(36);
const genId = () => b36(Date.now()) + Math.random().toString(36).slice(2, 6);
const uid7 = () => Math.random().toString(36).slice(2, 9);
const ml = (v) => (v && typeof v === 'object') ? { nl: v.nl || v.en || '', en: v.en || v.nl || '' } : { nl: v || '', en: v || '' };
function deepMerge(base, patch) {
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}
let TEMPLATES = null;
try { TEMPLATES = require('../lib/quoteTemplates.js'); } catch (e) { TEMPLATES = null; }
// Bouw een volledige offerte-data uit een compacte spec (zoals de skill-create). type bepaalt de
// template; project/client/conditions/payment/install/annexes worden erin gemerged; phases worden
// (indien opgegeven) opgebouwd uit compacte fase-specs met ext/int-tarieven per regel.
function buildQuoteFromSpec(spec) {
  if (!TEMPLATES) throw new Error('templates-unavailable');
  const typ = (spec && spec.type) === 'build' ? 'build' : 'assemble';
  const data = JSON.parse(JSON.stringify(TEMPLATES[typ]));
  data.lang = (spec && spec.lang) || data.lang || 'nl';
  data.project.date = (spec && spec.date) || new Date().toISOString().slice(0, 10);
  for (const sect of ['project', 'client', 'conditions', 'payment', 'install', 'annexes']) {
    if (spec && spec[sect]) deepMerge(data[sect], spec[sect]);
  }
  if (spec && spec.description !== undefined) {
    data.project.description = ml(spec.description);
    data.project.descBlocks = [{ id: uid7(), type: 'text', text: ml(spec.description) }];
  }
  if (spec && spec.tealRole !== undefined) data.project.tealRole = ml(spec.tealRole);
  if (spec && Array.isArray(spec.phases)) {
    let week = 0;
    data.phases = spec.phases.map((p) => {
      const dur = +(p.durationWeeks || 4);
      const desc = ml(p.description || '');
      const items = (p.items || []).map((it) => ({
        id: uid7(), role: it.role || 'design', desc: ml(it.desc || ''),
        qty: it.qty || 0, extRate: it.ext != null ? it.ext : (it.extRate || 0),
        intRate: it.int != null ? it.int : (it.intRate || 0), unit: it.unit || 'uur',
      }));
      const ph = {
        id: p.id || uid7(), code: p.code || '', name: ml(p.name || ''), desc, items,
        enabled: p.enabled !== false, customName: null, startWeek: week, durationWeeks: dur,
        description: desc, effort: '', contingency: p.contingency != null ? p.contingency : 0.1,
        travel: { trips: 0, km: 0, rate: 0.5, hours: 0, hourRate: 0 },
      };
      week += dur;
      return ph;
    });
  }
  for (const sect of ['procOTS', 'procCustom', 'subs']) {
    if (spec && Array.isArray(spec[sect])) data[sect] = spec[sect];
  }
  return data;
}
const isVisibleQuote = (e) => e && !e.deletedAt && (e.kind || 'quote') !== 'change_order' && (e.kind || 'quote') !== 'delivery';

function findEntries(archive, query) {
  const q = String(query || '').trim().toLowerCase();
  const exact = archive.filter((e) => e && (e.id === query || String(e.ref || '').toLowerCase() === q));
  if (exact.length) return exact;
  return archive.filter((e) => {
    if (!isVisibleQuote(e)) return false;
    const hay = [e.ref, e.projectName, e.clientName].map((x) => String(x || '')).join(' ').toLowerCase();
    return q && hay.indexOf(q) !== -1;
  });
}

// ── Tool-definities ──
const TOOLS = [
  {
    name: 'list_quotes',
    description: 'Lijst alle offertes in de workspace: ref, projectnaam, klant, status en id. Gebruik dit eerst om de juiste offerte te vinden.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_quote',
    description: 'Lees één offerte als volledige JSON (inclusief _archiveId). Zoekterm = ref, id, of deel van de project-/klantnaam. Bewerk daarna alleen wat nodig is en schrijf terug met write_quote — laat _archiveId ongemoeid.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'ref, id, of deel van project-/klantnaam' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'write_quote',
    description: 'Schrijf een (aangepaste) offerte terug. Geef het volledige data-object dat read_quote teruggaf, met dezelfde _archiveId — dan wordt de bestaande offerte in-place bijgewerkt (geen duplicaat). Zonder bekende _archiveId wordt een nieuwe offerte aangemaakt. De klant moet de Offerte Tool verversen om de wijziging te zien.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Volledig offerte-data-object (zoals read_quote teruggaf).' },
        message: { type: 'string', description: 'Korte changelog-notitie (optioneel).' },
      },
      required: ['data'], additionalProperties: false,
    },
  },
  {
    name: 'create_quote',
    description: 'Maak een NIEUWE offerte vanaf een template + compacte spec. Gebruik dit voor "beschrijf de klus en genereer een concept". spec: {type:"assemble"|"build", lang, project:{name,location,description,...}, client:{name,email,...}, phases:[{code,name,description,items:[{desc,qty,ext,int,role,unit}]}], conditions, payment, install}. ext=klanttarief, int=kostprijs. Weggelaten delen houden de template-standaard (voorwaarden, bijlagen, betaaltermijnen). Stel realistische fases en inzet voor; baseer je desnoods op een vergelijkbare bestaande offerte via read_quote.',
    inputSchema: {
      type: 'object',
      properties: { spec: { type: 'object', description: 'Compacte offerte-spec (zie beschrijving).' } },
      required: ['spec'], additionalProperties: false,
    },
  },
];

async function callTool(ws, name, args) {
  if (name === 'list_quotes') {
    const archive = await getArchive(ws);
    const rows = archive.filter(isVisibleQuote)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((e) => ({ ref: e.ref || '', projectName: e.projectName || '', clientName: e.clientName || '', status: e.status || 'concept', id: e.id }));
    return { text: rows.length ? JSON.stringify(rows, null, 2) : '(geen offertes in deze workspace)' };
  }
  if (name === 'read_quote') {
    const archive = await getArchive(ws);
    const hits = findEntries(archive, args && args.query);
    if (!hits.length) return { text: 'Geen offerte gevonden voor "' + (args && args.query) + '". Gebruik list_quotes.', isError: true };
    if (hits.length > 1) {
      const list = hits.map((e) => '- ' + e.ref + '  ' + (e.projectName || '—') + '  (' + (e.clientName || '—') + ')  id=' + e.id).join('\n');
      return { text: 'Meerdere offertes matchen. Verfijn met een ref of id:\n' + list, isError: true };
    }
    const entry = hits[0];
    const data = Object.assign({}, entry.data || {});
    data._archiveId = entry.id;
    return { text: JSON.stringify(data, null, 2) };
  }
  if (name === 'write_quote') {
    const data = args && args.data;
    if (!data || typeof data !== 'object' || !data.phases) {
      return { text: 'FOUT: "data" lijkt geen offerte (geen phases-veld).', isError: true };
    }
    const archive = await getArchive(ws);
    const now = nowIso();
    const aid = data._archiveId;
    const idx = archive.findIndex((e) => e && e.id === aid);
    const projectName = (data.project && data.project.name) || '';
    const clientName = (data.client && data.client.name) || '';
    const action = (args && args.message) || 'bewerkt via Claude';
    let verb, ref;
    if (idx >= 0) {
      const e = archive[idx];
      e.ref = data.ref || e.ref; e.type = data.type || e.type; e.lang = data.lang || e.lang;
      e.projectName = projectName; e.clientName = clientName; e.updatedAt = now;
      if (!Array.isArray(e.changelog)) e.changelog = [];
      e.changelog.push({ action, date: now });
      const d2 = Object.assign({}, data); d2._archiveId = e.id;
      e.data = d2; verb = 'bijgewerkt'; ref = e.ref;
    } else {
      const newId = aid || genId();
      const d2 = Object.assign({}, data); d2._archiveId = newId;
      archive.push({
        id: newId, ref: data.ref || '', type: data.type || 'assemble', lang: data.lang || 'nl',
        kind: 'quote', parentRef: null, parentId: null, projectName, clientName,
        status: 'concept', statusAt: null, createdAt: now, updatedAt: now,
        changelog: [{ action: 'created', date: now }], data: d2,
      });
      verb = 'aangemaakt'; ref = d2.ref;
    }
    await setArchive(ws, archive);
    return { text: 'Offerte ' + (ref || '?') + ' (' + (projectName || '—') + ') ' + verb + ' en gesynct. Ververs de Offerte Tool om de wijziging te zien.' };
  }
  if (name === 'create_quote') {
    if (!TEMPLATES) return { text: 'FOUT: templates niet beschikbaar op de server.', isError: true };
    const spec = (args && args.spec) || {};
    let data;
    try { data = buildQuoteFromSpec(spec); } catch (e) { return { text: 'FOUT bij opbouwen: ' + String((e && e.message) || e), isError: true }; }
    const archive = await getArchive(ws);
    const refs = new Set(archive.map((e) => e && e.ref));
    const baseRef = spec.ref || (((spec.type === 'build') ? 'B' : 'A') + '-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-1');
    let ref = baseRef, n = 1;
    while (refs.has(ref)) { n += 1; ref = baseRef.replace(/-\d+$/, '') + '-' + n; }
    data.ref = ref;
    const now = nowIso();
    const newId = genId();
    data._archiveId = newId;
    const projectName = (data.project && data.project.name) || '';
    const clientName = (data.client && data.client.name) || '';
    archive.push({
      id: newId, ref, type: data.type || 'assemble', lang: data.lang || 'nl',
      kind: 'quote', parentRef: null, parentId: null, projectName, clientName,
      status: 'concept', statusAt: null, createdAt: now, updatedAt: now,
      changelog: [{ action: 'aangemaakt via Claude', date: now }], data,
    });
    await setArchive(ws, archive);
    return { text: 'Nieuwe offerte ' + ref + ' (' + (projectName || '—') + ') aangemaakt en gesynct. Ververs de Offerte Tool om hem te zien.' };
  }
  return { text: 'Onbekende tool: ' + name, isError: true };
}

// ── JSON-RPC dispatch ──
async function handleRpc(msg, ws) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    const pv = (params && params.protocolVersion) || PROTOCOL_FALLBACK;
    return { jsonrpc: '2.0', id, result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/call') {
    if (!ws || ws.length < 8) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'FOUT: geen geldige workspace-id. Voeg ?ws=<token> toe aan de connector-URL of zet env TEAL_OFFERTE_WS.' }], isError: true } };
    }
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const out = await callTool(ws, name, args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'FOUT: ' + String((e && e.message) || e) }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  // Stateless server: no SSE stream on GET.
  if (req.method === 'GET') { res.setHeader('Allow', 'POST, OPTIONS'); res.status(405).json({ error: 'method-not-allowed' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }

  const ws = cleanWs((req.query && req.query.ws) || process.env.TEAL_OFFERTE_WS);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; } }
  if (!body) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty body' } }); return; }

  try {
    // Notifications (geen id) → 202, geen JSON-RPC-antwoord.
    const isNotification = (m) => m && m.id === undefined && typeof m.method === 'string';
    if (Array.isArray(body)) {
      const responses = [];
      for (const m of body) { if (isNotification(m)) continue; responses.push(await handleRpc(m, ws)); }
      if (!responses.length) { res.status(202).end(); return; }
      res.status(200).json(responses); return;
    }
    if (isNotification(body)) { res.status(202).end(); return; }
    const response = await handleRpc(body, ws);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(response);
  } catch (e) {
    res.status(200).json({ jsonrpc: '2.0', id: (body && body.id) || null, error: { code: -32603, message: String((e && e.message) || e) } });
  }
};
