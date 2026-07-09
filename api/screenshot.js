// /api/screenshot — render the page behind a deliverable link to an image and
// return it as a base64 data URL, so the offerte PDF can embed it as a
// clickable screenshot. Runs headless Chromium on Vercel.
//
// POST body (JSON): { url, fullPage?:boolean, width?:int, height?:int }
//   -> { dataUrl }        image/jpeg base64 data URL
//   -> { error }          on failure (4xx/5xx)
//
// Only http(s) URLs are accepted. Viewport capture by default (1280x800 @2x,
// JPEG q72) to keep the payload small — screenshots are stored inside the quote
// JSON (localStorage + /api/share), so we trade a little sharpness for size.
//
// Requires deps (see package.json): puppeteer-core + @sparticuz/chromium.

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'invalid-url' });

  const width = Math.min(2000, Math.max(320, parseInt(body.width, 10) || 1280));
  const height = Math.min(4000, Math.max(320, parseInt(body.height, 10) || 800));
  const fullPage = !!body.fullPage;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width, height, deviceScaleFactor: 2 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    // Let lazy content, webfonts and above-the-fold animations settle.
    await new Promise((r) => setTimeout(r, 700));
    const buf = await page.screenshot({ type: 'jpeg', quality: 72, fullPage });
    const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64');
    return res.status(200).json({ dataUrl });
  } catch (e) {
    const msg = String((e && e.message) || e);
    return res.status(502).json({ error: 'screenshot-failed: ' + msg });
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
  }
};
