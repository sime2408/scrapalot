#!/usr/bin/env node
/**
 * Generate the 1200x630 Open Graph social card at public/og-image.png.
 *
 * Renders a branded HTML card in headless Chromium (via the project's Playwright)
 * at exactly 1200x630 and screenshots it. Re-run this after changing the wordmark,
 * tagline, descriptor, or brand colors below.
 *
 * Usage (from the scrapalot-ui project root):
 *   node scripts/gen-og.cjs
 *
 * Requires Playwright browsers (already installed for E2E). The output is
 * referenced by og:image / twitter:image in index.html.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const LOGO = path.join(ROOT, 'public', 'logo512-circle-color.png');
const OUT = path.join(ROOT, 'public', 'og-image.png');

// --- Card content (edit here) ---------------------------------------------
const WORDMARK = 'Scrapalot';
const TAGLINE = 'AI Research Assistant';
const DESCRIPTOR =
  'Talk to your documents, run deep research, and explore knowledge graphs &mdash; every answer cites its sources.';
const FOOTER = 'scrapalot.app';
// --------------------------------------------------------------------------

const logo = fs.readFileSync(LOGO).toString('base64');

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400..700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; overflow:hidden; }
  body {
    background:
      radial-gradient(900px 500px at 12% 8%, rgba(59,130,246,0.20), transparent 55%),
      radial-gradient(700px 600px at 100% 100%, rgba(59,130,246,0.10), transparent 50%),
      #09090b;
    color:#fafafa;
    font-family:'Newsreader', Georgia, serif;
    -webkit-font-smoothing:antialiased;
    position:relative;
  }
  .frame { position:absolute; inset:24px; border:1px solid rgba(255,255,255,0.08); }
  .wrap { position:relative; height:100%; display:flex; flex-direction:column; justify-content:center; padding:92px; }
  .brandrow { display:flex; align-items:center; gap:28px; margin-bottom:30px; }
  .logo { width:104px; height:104px; }
  .wordmark { font-size:104px; font-weight:600; letter-spacing:-0.02em; line-height:1; }
  .tagline { font-size:40px; font-weight:500; color:#60a5fa; letter-spacing:-0.01em; margin-bottom:34px; }
  .rule { width:96px; height:3px; background:#3b82f6; margin-bottom:34px; }
  .desc { font-size:30px; line-height:1.4; color:#a1a1aa; max-width:980px; font-weight:400; }
  .footer { position:absolute; left:92px; bottom:64px; font-family:'JetBrains Mono', monospace; font-size:24px; color:#71717a; letter-spacing:0.02em; }
</style></head>
<body>
  <div class="frame"></div>
  <div class="wrap">
    <div class="brandrow">
      <img class="logo" src="data:image/png;base64,${logo}" alt="">
      <div class="wordmark">${WORDMARK}</div>
    </div>
    <div class="tagline">${TAGLINE}</div>
    <div class="rule"></div>
    <div class="desc">${DESCRIPTOR}</div>
  </div>
  <div class="footer">${FOOTER}</div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser.close();
  console.log('Wrote', path.relative(ROOT, OUT));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
