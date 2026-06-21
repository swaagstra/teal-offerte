// /api/odoo — push an accepted quote or change order into TEAL Odoo as a
// DRAFT customer invoice (account.move, move_type=out_invoice). Never posts,
// confirms, sends or pays anything. The user reviews the draft in Odoo.
//
// POST body (JSON):
//   { type:'quote'|'change_order', ref, lang,
//     client:{ name, email, contact },
//     note, lines:[ { name, price } ] }
// -> { ok:true, invoiceId, partnerId, url }
//
// Env vars (set in Vercel project settings, never in the frontend):
//   ODOO_URL            e.g. https://teal.odoo.com   (no trailing slash)
//   ODOO_DB             database name
//   ODOO_LOGIN          user login (email)
//   ODOO_APIKEY         API key / password for that user
//   ODOO_INCOME_ACCOUNT_ID   (optional) account.account id for invoice lines
//   ODOO_JOURNAL_ID          (optional) sales journal id
//   ODOO_TAX_ID              (optional) account.tax id, e.g. BTW 21%, applied to every line
//
// Zero npm dependencies: XML-RPC is built by hand over global fetch.

const URLB = (process.env.ODOO_URL || '').replace(/\/+$/, '');
const DB = process.env.ODOO_DB || '';
const LOGIN = process.env.ODOO_LOGIN || '';
const APIKEY = process.env.ODOO_APIKEY || '';
const INCOME_ACCT = process.env.ODOO_INCOME_ACCOUNT_ID ? parseInt(process.env.ODOO_INCOME_ACCOUNT_ID) : null;
const JOURNAL_ID = process.env.ODOO_JOURNAL_ID ? parseInt(process.env.ODOO_JOURNAL_ID) : null;
const TAX_ID = process.env.ODOO_TAX_ID ? parseInt(process.env.ODOO_TAX_ID) : null;

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function enc(v) {
  if (v === null || v === undefined || v === false) return '<value><boolean>0</boolean></value>';
  if (v === true) return '<value><boolean>1</boolean></value>';
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? '<value><int>' + v + '</int></value>'
      : '<value><double>' + v + '</double></value>';
  }
  if (typeof v === 'string') return '<value><string>' + xmlEsc(v) + '</string></value>';
  if (Array.isArray(v)) return '<value><array><data>' + v.map(enc).join('') + '</data></array></value>';
  if (typeof v === 'object') {
    let s = '<value><struct>';
    for (const k in v) s += '<member><name>' + xmlEsc(k) + '</name>' + enc(v[k]) + '</member>';
    return s + '</struct></value>';
  }
  return '<value><string></string></value>';
}
function methodCall(method, params) {
  return '<?xml version="1.0"?><methodCall><methodName>' + method + '</methodName><params>' +
    params.map(p => '<param>' + enc(p) + '</param>').join('') + '</params></methodCall>';
}
function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function isFault(xml) { return /<fault\b/.test(xml); }
function faultMsg(xml) {
  const m = xml.match(/faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/);
  return m ? unesc(m[1]).split('\n')[0].slice(0, 300) : 'odoo-fault';
}
function firstInt(xml) {
  const m = xml.match(/<(?:int|i4)>(-?\d+)<\/(?:int|i4)>/);
  return m ? parseInt(m[1]) : null;
}
function allInts(xml) {
  const out = []; const re = /<(?:int|i4)>(-?\d+)<\/(?:int|i4)>/g; let m;
  while ((m = re.exec(xml))) out.push(parseInt(m[1]));
  return out;
}

async function rpc(path, method, params) {
  if (!URLB) throw new Error('odoo-not-configured');
  const r = await fetch(URLB + path, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: methodCall(method, params),
  });
  const xml = await r.text();
  if (isFault(xml)) throw new Error(faultMsg(xml));
  return xml;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method-not-allowed' });
    }
    if (!URLB || !DB || !LOGIN || !APIKEY) {
      return res.status(501).json({ error: 'odoo-not-configured' });
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'bad-json' }); } }
    const client = (body && body.client) || {};
    const lines = (body && body.lines) || [];
    if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'no-lines' });

    // 1) authenticate
    const uid = firstInt(await rpc('/xmlrpc/2/common', 'authenticate', [DB, LOGIN, APIKEY, {}]));
    if (!uid) return res.status(401).json({ error: 'odoo-auth-failed' });
    const exec = (model, method, args, kwargs) =>
      rpc('/xmlrpc/2/object', 'execute_kw', [DB, uid, APIKEY, model, method, args || [], kwargs || {}]);

    // 2) find or create the partner
    let partnerId = null;
    const email = (client.email || '').trim();
    const name = (client.name || '').trim();
    if (email) partnerId = allInts(await exec('res.partner', 'search', [[['email', '=', email]]], { limit: 1 }))[0] || null;
    if (!partnerId && name) partnerId = allInts(await exec('res.partner', 'search', [[['name', '=', name]]], { limit: 1 }))[0] || null;
    if (!partnerId) {
      partnerId = firstInt(await exec('res.partner', 'create', [{ name: name || email || 'Onbekende klant', email: email || false }]));
    }
    if (!partnerId) return res.status(500).json({ error: 'partner-failed' });

    // 3) create the DRAFT customer invoice(s)
    const lineVals = (l) => {
      const vals = { name: String(l.name || '').slice(0, 500) || (body.ref || 'Regel'), quantity: 1, price_unit: Number(l.price) || 0 };
      if (INCOME_ACCT) vals.account_id = INCOME_ACCT;
      if (TAX_ID) vals.tax_ids = [[6, 0, [TAX_ID]]];
      return [0, 0, vals];
    };
    const createInvoice = async (invLines, ref, note, date) => {
      const moveVals = { move_type: 'out_invoice', partner_id: partnerId, invoice_line_ids: invLines.map(lineVals) };
      if (ref) moveVals.ref = String(ref).slice(0, 100);
      if (note) moveVals.narration = String(note).slice(0, 2000);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) moveVals.invoice_date = date;
      if (JOURNAL_ID) moveVals.journal_id = JOURNAL_ID;
      return firstInt(await exec('account.move', 'create', [moveVals]));
    };
    const urlFor = (id) => URLB + '/web#id=' + id + '&model=account.move&view_type=form';

    const milestones = Array.isArray(body.milestones) ? body.milestones : [];
    const invoices = [];
    if (milestones.length > 1) {
      // one draft invoice per payment instalment
      const n = milestones.length;
      for (let i = 0; i < n; i++) {
        const m = milestones[i];
        const lineName = (body.note ? body.note + ' — ' : '') + (m.name || ('Termijn ' + (i + 1))) + ' (' + (m.pct || 0) + '%)';
        const id = await createInvoice([{ name: lineName, price: Number(m.amount) || 0 }], (body.ref || '') + ' T' + (i + 1) + '/' + n, body.note, m.date);
        if (!id) return res.status(500).json({ error: 'invoice-failed' });
        invoices.push({ id, label: 'Termijn ' + (i + 1) + '/' + n, url: urlFor(id) });
      }
    } else {
      const id = await createInvoice(lines, body.ref, body.note);
      if (!id) return res.status(500).json({ error: 'invoice-failed' });
      invoices.push({ id, label: 'Factuur', url: urlFor(id) });
    }

    return res.status(200).json({ ok: true, partnerId, invoices, invoiceId: invoices[0].id, url: invoices[0].url });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const code = msg === 'odoo-not-configured' ? 501 : 500;
    return res.status(code).json({ error: msg });
  }
};
