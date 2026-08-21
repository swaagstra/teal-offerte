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
