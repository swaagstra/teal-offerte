// /api/mcp — remote MCP server voor de TEAL Offerte Tool (TypeScript).
//
// Geeft Claude (claude.ai / Cowork / Claude Code, via een custom connector) een direct
// lees/schrijf-pad naar het offerte-archief van één workspace. Praat met dezelfde Upstash-opslag
// als /api/archive: offertes staan als entries { id, …meta, data } in één array onder de key
// arch:<ws>. Tools: list_quotes, read_quote, write_quote, create_quote, patch_quote.
//
// Beveiliging: de workspace-token ÍS de sleutel (net als de ?ws=-deellink) — via ?ws=<token> of
// env TEAL_OFFERTE_WS. Ingesloten base64-afbeeldingen worden bij opslaan naar Vercel Blob verplaatst
// (zie lib/images.ts), zodat documenten klein blijven.

import { put } from '@vercel/blob';
import { createHash } from 'node:crypto';
import quoteTemplates from '../lib/quoteTemplates.js';

// NB: dezelfde offload-logica staat ook in lib/images.ts (voor scripts/migrate-images.ts). Hier
// inline gehouden zodat de serverless-route geen relatieve .ts-import heeft (die faalt op Vercel).
const DATA_IMG = /^data:image\/([a-zA-Z0-9.+-]+);base64,/;
const isDataImage = (v: unknown): v is string => typeof v === 'string' && DATA_IMG.test(v);
const blobConfigured = (): boolean => !!process.env.BLOB_READ_WRITE_TOKEN;
function extFromMime(mime: string): string {
  const t = mime.toLowerCase();
  if (t === 'jpeg' || t === 'jpg') return 'jpg';
  if (t === 'svg+xml') return 'svg';
  return t.replace(/[^a-z0-9]/g, '') || 'png';
}
async function uploadDataImage(archiveId: string, dataUrl: string): Promise<string> {
  const m = DATA_IMG.exec(dataUrl);
  if (!m) return dataUrl;
  const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const { url } = await put(`quotes/${archiveId}/${hash}.${extFromMime(m[1])}`, buf, {
    access: 'public', contentType: `image/${m[1]}`, addRandomSuffix: false, allowOverwrite: true,
  });
  return url;
}
// Recursief: vervang elke data:image-string door zijn Blob https-URL (mutatie). Best-effort: een
// mislukte upload behoudt de originele data: URL, zodat opslaan nooit breekt.
async function offloadImages(node: unknown, archiveId: string): Promise<void> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const v = node[i];
      if (isDataImage(v)) { try { node[i] = await uploadDataImage(archiveId, v); } catch { /* keep */ } }
      else if (v && typeof v === 'object') await offloadImages(v, archiveId);
    }
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (isDataImage(v)) { try { obj[k] = await uploadDataImage(archiveId, v); } catch { /* keep */ } }
      else if (v && typeof v === 'object') await offloadImages(v, archiveId);
    }
  }
}

// ── Minimale Vercel-request/response types (geen @vercel/node-dependency nodig) ──
interface VercelReq {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface VercelRes {
  setHeader(name: string, value: string): void;
  status(code: number): VercelRes;
  json(body: unknown): void;
  end(): void;
}

type Dict = Record<string, unknown>;
interface ArchiveEntry {
  id: string;
  ref?: string;
  type?: string;
  lang?: string;
  kind?: string;
  parentRef?: string | null;
  parentId?: string | null;
  projectName?: string;
  clientName?: string;
  status?: string;
  statusAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string;
  changelog?: { action: string; date: string }[];
  data?: Dict;
}

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 365 * 2; // 2 jaar
const SERVER_INFO = { name: 'teal-offerte', version: '1.1.0' };
const PROTOCOL_FALLBACK = '2025-06-18';

async function redis(cmd: (string | number)[]): Promise<unknown> {
  if (!BASE || !TOKEN) throw new Error('storage-not-configured');
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = (await r.json()) as { error?: string; result?: unknown };
  if (j.error) throw new Error(j.error);
  return j.result;
}
const cleanWs = (v: unknown): string => String(v || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
async function getArchive(ws: string): Promise<ArchiveEntry[]> {
  const v = await redis(['GET', 'arch:' + ws]);
  try { const a = JSON.parse((v as string) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function setArchive(ws: string, arr: ArchiveEntry[]): Promise<void> {
  const payload = JSON.stringify(arr);
  if (payload.length > 5000000) throw new Error('too-large');
  await redis(['SET', 'arch:' + ws, payload, 'EX', TTL]);
}
const nowIso = (): string => new Date().toISOString();
const genId = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const uid7 = (): string => Math.random().toString(36).slice(2, 9);
const isPlainObject = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const ml = (v: unknown): { nl: string; en: string } => {
  if (isPlainObject(v)) return { nl: String(v.nl ?? v.en ?? ''), en: String(v.en ?? v.nl ?? '') };
  const s = (v as string) || '';
  return { nl: s, en: s };
};

// ── create_quote: bouw een offerte uit een compacte spec + template ──
function deepMerge(base: Dict, patch: Dict): Dict {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (isPlainObject(v) && isPlainObject(base[k])) deepMerge(base[k] as Dict, v);
    else base[k] = v;
  }
  return base;
}
const TEMPLATES = quoteTemplates as unknown as Record<string, Dict>;
function buildQuoteFromSpec(spec: Dict): Dict {
  if (!TEMPLATES) throw new Error('templates-unavailable');
  const typ = spec.type === 'build' ? 'build' : 'assemble';
  const data = JSON.parse(JSON.stringify(TEMPLATES[typ])) as Dict;
  data.lang = (spec.lang as string) || (data.lang as string) || 'nl';
  (data.project as Dict).date = (spec.date as string) || new Date().toISOString().slice(0, 10);
  for (const sect of ['project', 'client', 'conditions', 'payment', 'install', 'annexes']) {
    if (isPlainObject(spec[sect])) deepMerge(data[sect] as Dict, spec[sect] as Dict);
  }
  if (spec.description !== undefined) {
    (data.project as Dict).description = ml(spec.description);
    (data.project as Dict).descBlocks = [{ id: uid7(), type: 'text', text: ml(spec.description) }];
  }
  if (spec.tealRole !== undefined) (data.project as Dict).tealRole = ml(spec.tealRole);
  if (Array.isArray(spec.phases)) {
    let week = 0;
    data.phases = (spec.phases as Dict[]).map((p) => {
      const dur = Number(p.durationWeeks || 4);
      const desc = ml(p.description || '');
      const items = ((p.items as Dict[]) || []).map((it) => ({
        id: uid7(), role: (it.role as string) || 'design', desc: ml(it.desc || ''),
        qty: it.qty || 0, extRate: it.ext != null ? it.ext : (it.extRate || 0),
        intRate: it.int != null ? it.int : (it.intRate || 0), unit: (it.unit as string) || 'uur',
      }));
      const ph: Dict = {
        id: (p.id as string) || uid7(), code: (p.code as string) || '', name: ml(p.name || ''), desc, items,
        enabled: p.enabled !== false, customName: null, startWeek: week, durationWeeks: dur,
        description: desc, effort: '', contingency: p.contingency != null ? p.contingency : 0.1,
        travel: { trips: 0, km: 0, rate: 0.5, hours: 0, hourRate: 0 },
      };
      week += dur;
      return ph;
    });
  }
  for (const sect of ['procOTS', 'procCustom', 'subs']) {
    if (Array.isArray(spec[sect])) data[sect] = spec[sect];
  }
  return data;
}

const isVisibleQuote = (e: ArchiveEntry): boolean =>
  !!e && !e.deletedAt && (e.kind || 'quote') !== 'change_order' && (e.kind || 'quote') !== 'delivery';

function findEntries(archive: ArchiveEntry[], query: unknown): ArchiveEntry[] {
  const q = String(query || '').trim().toLowerCase();
  const exact = archive.filter((e) => e && (e.id === query || String(e.ref || '').toLowerCase() === q));
  if (exact.length) return exact;
  return archive.filter((e) => {
    if (!isVisibleQuote(e)) return false;
    const hay = [e.ref, e.projectName, e.clientName].map((x) => String(x || '')).join(' ').toLowerCase();
    return q !== '' && hay.indexOf(q) !== -1;
  });
}

// ── patch_quote: partiële merge met validatie ──
// Whitelist van sleutels die (nieuw) mogen voorkomen. Alles wat niet in het document staat én niet
// hierin staat, wordt geweigerd — zo worden typefouten niet stilzwijgend als nieuwe sleutel gezet.
export const PATCH_WHITELIST: ReadonlySet<string> = new Set([
  // top-level
  'v', 'type', 'lang', 'ref', 'project', 'client', 'phases', 'procOTS', 'procCustom', 'subs',
  'install', 'travel', 'payment', 'conditions', 'batchSize', 'annexes', 'costOrder',
  'multiOption', 'options', 'kind', 'parentRef', 'parentId', 'timeline',
  // project
  'name', 'subtitle', 'preparedBy', 'phaseLabel', 'date', 'location', 'description', 'tealRole',
  'exclusions', 'exclusionItems', 'exclusionImages', 'descBlocks', 'links',
  // client
  'contact', 'email', 'addr', 'zip', 'city',
  // phase + items
  'id', 'code', 'desc', 'items', 'enabled', 'customName', 'startWeek', 'durationWeeks', 'effort',
  'contingency', 'role', 'qty', 'extRate', 'intRate', 'unit',
  // travel / mobilisation
  'trips', 'km', 'rate', 'hours', 'hourRate', 'rateNL', 'note',
  // procurement / subs
  'supplier', 'company', 'amount', 'handlingPct', 'riskPct', 'coordPct', 'showAs', 'phaseId',
  // install
  'crew', 'coordOn', 'dest', 'flight', 'visa', 'hotelPN', 'hotelP', 'pdTier', 'pdRateStd',
  'pdRateCity', 'pdDays', 'kmNL', 'transMode', 'transCost', 'park', 'co2', 'sbDays', 'sbRate',
  'conPct', 'res', 'custom', 'wd', 'td', 'hn', 'ot', 'cal', 'sb', 'pd',
  'hotelN', 'hotelR', 'pdRate', 'bookOn', 'co2bill', 'hotelNManual', 'pdDaysManual',
  // payment / conditions
  'milestones', 'pct', 'validity', 'paymentTerm', 'warranty', 'warrantyEnabled', 'meerwerk',
  'meerwerkEnabled', 'akkoord', 'akkoordEnabled', 'avNL', 'avEN', 'exclusionsEnabled',
  // annexes + blocks
  'assumptions', 'rateCard', 'responsibilities', 'custom', 'text', 'rows', 'label', 'party',
  'item', 'title', 'src', 'caption',
  // bilingual + markers
  'nl', 'en', '_ensrc',
  // barLabel / step fields used in timeline
  'barLabel', 'startWeek', 'durationWeeks',
]);

// Recursief mergen van `patch` in `target`. Regels: objecten recursief, arrays volledig vervangen,
// null verwijdert de sleutel, _archiveId genegeerd, onbekende sleutels geweigerd (throw). Vult
// `changed` met de gewijzigde paden.
export function mergePatch(target: Dict, patch: Dict, path: string, changed: string[]): void {
  for (const key of Object.keys(patch)) {
    if (key === '_archiveId') continue;
    const full = path ? path + '.' + key : key;
    const exists = Object.prototype.hasOwnProperty.call(target, key);
    if (!exists && !PATCH_WHITELIST.has(key)) {
      throw new Error('onbekende sleutel geweigerd: ' + full);
    }
    const pv = patch[key];
    if (pv === null) {
      if (exists) { delete target[key]; changed.push(full + ' (verwijderd)'); }
      continue;
    }
    if (isPlainObject(pv) && isPlainObject(target[key])) {
      mergePatch(target[key] as Dict, pv, full, changed);
    } else if (isPlainObject(pv)) {
      const sub: Dict = {};
      target[key] = sub;
      mergePatch(sub, pv, full, changed);
    } else {
      // scalar of array → in zijn geheel vervangen
      target[key] = pv;
      changed.push(full + (Array.isArray(pv) ? ' (array vervangen)' : ''));
    }
  }
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
    description: 'Lees één offerte als volledige JSON (inclusief _archiveId). Zoekterm = ref, id, of deel van de project-/klantnaam. Afbeeldingen komen als https-URL terug (niet als bytes). Bewerk daarna met patch_quote (alleen de gewijzigde velden) — of, alleen voor een volledige vervanging, met write_quote.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'ref, id, of deel van project-/klantnaam' } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'patch_quote',
    description: 'BEWERK een bestaande offerte met een PARTIEEL patch-object (voorkeur boven write_quote, o.a. bij offertes met afbeeldingen). query = ref/id/naam (zelfde resolutie als read_quote). patch heeft dezelfde structuur als het document maar alleen de te wijzigen velden. Regels: objecten worden recursief gemerged; een array vervangt de bestaande array volledig; waarde null verwijdert de sleutel; onbekende sleutels worden geweigerd; _archiveId wordt genegeerd. Geeft de gewijzigde paden terug, niet het hele document. dry_run: true toont de paden zonder weg te schrijven.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'ref, id, of deel van project-/klantnaam' },
        patch: { type: 'object', description: 'Partieel offerte-object; alleen de te wijzigen velden.' },
        message: { type: 'string', description: 'Korte changelog-notitie (optioneel).' },
        dry_run: { type: 'boolean', description: 'Toon de gewijzigde paden zonder weg te schrijven.' },
      },
      required: ['query', 'patch'], additionalProperties: false,
    },
  },
  {
    name: 'write_quote',
    description: 'VOLLEDIGE VERVANGING van een offerte. Geef het complete data-object (zoals read_quote teruggaf) met dezelfde _archiveId → in-place bijgewerkt. Voor kleine bewerkingen: gebruik patch_quote (kleinere payload, veilig bij afbeeldingen). Zonder bekende _archiveId wordt een nieuwe offerte aangemaakt.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Volledig offerte-data-object.' },
        message: { type: 'string', description: 'Korte changelog-notitie (optioneel).' },
      },
      required: ['data'], additionalProperties: false,
    },
  },
  {
    name: 'create_quote',
    description: 'Maak een NIEUWE offerte vanaf een template + compacte spec. spec: {type:"assemble"|"build", lang, project:{name,location,description,...}, client:{name,email,...}, phases:[{code,name,description,items:[{desc,qty,ext,int,role,unit}]}], conditions, payment, install}. ext=klanttarief, int=kostprijs. Weggelaten delen houden de template-standaard.',
    inputSchema: {
      type: 'object',
      properties: { spec: { type: 'object', description: 'Compacte offerte-spec (zie beschrijving).' } },
      required: ['spec'], additionalProperties: false,
    },
  },
];

interface ToolResult { text: string; isError?: boolean }

async function callTool(ws: string, name: string, args: Dict): Promise<ToolResult> {
  if (name === 'list_quotes') {
    const archive = await getArchive(ws);
    const rows = archive.filter(isVisibleQuote)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map((e) => ({ ref: e.ref || '', projectName: e.projectName || '', clientName: e.clientName || '', status: e.status || 'concept', id: e.id }));
    return { text: rows.length ? JSON.stringify(rows, null, 2) : '(geen offertes in deze workspace)' };
  }

  if (name === 'read_quote') {
    const archive = await getArchive(ws);
    const hits = findEntries(archive, args.query);
    if (!hits.length) return { text: 'Geen offerte gevonden voor "' + String(args.query) + '". Gebruik list_quotes.', isError: true };
    if (hits.length > 1) {
      const list = hits.map((e) => '- ' + e.ref + '  ' + (e.projectName || '—') + '  (' + (e.clientName || '—') + ')  id=' + e.id).join('\n');
      return { text: 'Meerdere offertes matchen. Verfijn met een ref of id:\n' + list, isError: true };
    }
    const entry = hits[0];
    const data: Dict = { ...(entry.data || {}), _archiveId: entry.id };
    return { text: JSON.stringify(data, null, 2) };
  }

  if (name === 'patch_quote') {
    const patch = args.patch;
    if (!isPlainObject(patch)) return { text: 'FOUT: "patch" moet een object zijn.', isError: true };
    const archive = await getArchive(ws);
    const hits = findEntries(archive, args.query);
    if (!hits.length) return { text: 'Geen offerte gevonden voor "' + String(args.query) + '". Gebruik list_quotes.', isError: true };
    if (hits.length > 1) {
      const list = hits.map((e) => '- ' + e.ref + '  (' + (e.projectName || '—') + ')  id=' + e.id).join('\n');
      return { text: 'Meerdere offertes matchen "' + String(args.query) + '". Verfijn met een ref of id — niets gewijzigd:\n' + list, isError: true };
    }
    const entry = hits[0];
    const doc = JSON.parse(JSON.stringify(entry.data || {})) as Dict;
    const changed: string[] = [];
    try {
      mergePatch(doc, patch, '', changed);
    } catch (e) {
      return { text: 'FOUT: ' + String((e as Error).message) + ' — niets weggeschreven.', isError: true };
    }
    doc._archiveId = entry.id;
    const pathsText = changed.length ? changed.map((p) => '• ' + p).join('\n') : '(geen wijzigingen)';
    if (args.dry_run) {
      return { text: 'DRY RUN — zou wijzigen in ' + (entry.ref || '?') + ':\n' + pathsText };
    }
    if (blobConfigured()) await offloadImages(doc, entry.id);
    entry.data = doc;
    entry.ref = (doc.ref as string) || entry.ref;
    entry.projectName = ((doc.project as Dict) || {}).name as string || entry.projectName;
    entry.clientName = ((doc.client as Dict) || {}).name as string || entry.clientName;
    entry.updatedAt = nowIso();
    if (!Array.isArray(entry.changelog)) entry.changelog = [];
    entry.changelog.push({ action: (args.message as string) || 'gepatcht via Claude', date: nowIso() });
    await setArchive(ws, archive);
    return { text: 'Offerte ' + (entry.ref || '?') + ' gepatcht (' + changed.length + ' pad(en)). Gewijzigd:\n' + pathsText + '\n\nHerlaad de Offerte Tool om de wijziging te zien.' };
  }

  if (name === 'write_quote') {
    const data = args.data as Dict;
    if (!isPlainObject(data) || !data.phases) {
      return { text: 'FOUT: "data" lijkt geen offerte (geen phases-veld).', isError: true };
    }
    const archive = await getArchive(ws);
    const now = nowIso();
    const aid = data._archiveId as string | undefined;
    const idx = archive.findIndex((e) => e && e.id === aid);
    const projectName = ((data.project as Dict) || {}).name as string || '';
    const clientName = ((data.client as Dict) || {}).name as string || '';
    const action = (args.message as string) || 'bewerkt via Claude';
    let verb: string; let ref: string;
    if (idx >= 0) {
      const e = archive[idx];
      const d2: Dict = { ...data, _archiveId: e.id };
      if (blobConfigured()) await offloadImages(d2, e.id);
      e.ref = (data.ref as string) || e.ref; e.type = (data.type as string) || e.type; e.lang = (data.lang as string) || e.lang;
      e.projectName = projectName; e.clientName = clientName; e.updatedAt = now;
      if (!Array.isArray(e.changelog)) e.changelog = [];
      e.changelog.push({ action, date: now });
      e.data = d2; verb = 'bijgewerkt'; ref = e.ref || '';
    } else {
      const newId = aid || genId();
      const d2: Dict = { ...data, _archiveId: newId };
      if (blobConfigured()) await offloadImages(d2, newId);
      archive.push({
        id: newId, ref: (data.ref as string) || '', type: (data.type as string) || 'assemble', lang: (data.lang as string) || 'nl',
        kind: 'quote', parentRef: null, parentId: null, projectName, clientName,
        status: 'concept', statusAt: null, createdAt: now, updatedAt: now,
        changelog: [{ action: 'created', date: now }], data: d2,
      });
      verb = 'aangemaakt'; ref = (d2.ref as string) || '';
    }
    await setArchive(ws, archive);
    return { text: 'Offerte ' + (ref || '?') + ' (' + (projectName || '—') + ') ' + verb + ' en gesynct. Ververs de Offerte Tool om de wijziging te zien.' };
  }

  if (name === 'create_quote') {
    if (!TEMPLATES) return { text: 'FOUT: templates niet beschikbaar op de server.', isError: true };
    const spec = (args.spec as Dict) || {};
    let data: Dict;
    try { data = buildQuoteFromSpec(spec); } catch (e) { return { text: 'FOUT bij opbouwen: ' + String((e as Error).message), isError: true }; }
    const archive = await getArchive(ws);
    const refs = new Set(archive.map((e) => e && e.ref));
    const baseRef = (spec.ref as string) || ((spec.type === 'build' ? 'B' : 'A') + '-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-1');
    let ref = baseRef; let n = 1;
    while (refs.has(ref)) { n += 1; ref = baseRef.replace(/-\d+$/, '') + '-' + n; }
    data.ref = ref;
    const now = nowIso();
    const newId = genId();
    data._archiveId = newId;
    if (blobConfigured()) await offloadImages(data, newId);
    const projectName = ((data.project as Dict) || {}).name as string || '';
    const clientName = ((data.client as Dict) || {}).name as string || '';
    archive.push({
      id: newId, ref, type: (data.type as string) || 'assemble', lang: (data.lang as string) || 'nl',
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
interface RpcMsg { id?: unknown; method?: string; params?: Dict }
async function handleRpc(msg: RpcMsg, ws: string): Promise<unknown> {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    const pv = (params && (params.protocolVersion as string)) || PROTOCOL_FALLBACK;
    return { jsonrpc: '2.0', id, result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/call') {
    if (!ws || ws.length < 8) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'FOUT: geen geldige workspace-id. Voeg ?ws=<token> toe aan de connector-URL of zet env TEAL_OFFERTE_WS.' }], isError: true } };
    }
    const name = (params && (params.name as string)) || '';
    const args = (params && (params.arguments as Dict)) || {};
    try {
      const out = await callTool(ws, name, args);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.text }], isError: !!out.isError } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'FOUT: ' + String((e as Error).message || e) }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method === 'GET') { res.setHeader('Allow', 'POST, OPTIONS'); res.status(405).json({ error: 'method-not-allowed' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method-not-allowed' }); return; }

  const ws = cleanWs((req.query && (req.query.ws as string)) || process.env.TEAL_OFFERTE_WS);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; } }
  if (!body) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty body' } }); return; }

  try {
    const isNotification = (m: RpcMsg): boolean => !!m && m.id === undefined && typeof m.method === 'string';
    if (Array.isArray(body)) {
      const responses: unknown[] = [];
      for (const m of body as RpcMsg[]) { if (isNotification(m)) continue; responses.push(await handleRpc(m, ws)); }
      if (!responses.length) { res.status(202).end(); return; }
      res.status(200).json(responses); return;
    }
    if (isNotification(body as RpcMsg)) { res.status(202).end(); return; }
    const response = await handleRpc(body as RpcMsg, ws);
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(response);
  } catch (e) {
    res.status(200).json({ jsonrpc: '2.0', id: (body as RpcMsg)?.id ?? null, error: { code: -32603, message: String((e as Error).message || e) } });
  }
}
