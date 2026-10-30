#!/usr/bin/env node
/*
 Browser check of the code-protected Gallup website before it is pushed.

   ACCESS_CODE=<code> node tools/check_site.js [index.html] [<records .json>]

 Serves the site folder on 127.0.0.1 and opens it in headless Chromium (Playwright). Passes only when:
   - a wrong code is refused and the right code opens Gallup;
   - the app shows the bundled records (Styles count for the default season matches the records file);
   - a record added in the browser is still there after a reload, and Export records downloads it;
   - the page makes no request to any other server, and has no script errors, blocked loads or
     fingerprint failures;
   - a deliberately altered copy of every fingerprinted file (fonts/fonts.css, lib/*.js) is refused.
 Prints PASS or FAIL.
*/
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const [siteArg = path.join(ROOT, 'index.html'), dataArg] = process.argv.slice(2);
const code = process.env.ACCESS_CODE;
if (!code) { console.error('usage: ACCESS_CODE=<code> node tools/check_site.js [index.html] [records.json]'); process.exit(2); }
const data = dataArg && fs.existsSync(dataArg) ? JSON.parse(fs.readFileSync(dataArg, 'utf8')) : null;
const dir = path.dirname(path.resolve(siteArg)), file = path.basename(siteArg);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
const srv = http.createServer((q, r) => {
  const p = path.join(dir, decodeURIComponent(q.url.split('?')[0]));
  if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r);
});
const wrong = 'WRONG-CODE-0000';
async function open(ctx, base) {
  const p = await ctx.newPage(), log = { errs: [], console: [], outside: [] };
  p.on('pageerror', e => log.errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') log.console.push(m.text()); });
  p.on('request', q => { const u = new URL(q.url()); if (u.hostname !== '127.0.0.1' && !['data:', 'blob:'].includes(u.protocol)) log.outside.push(q.url()); });
  await p.goto(base + '/' + file);
  return { p, log };
}
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port, b = await chromium.launch(), problems = [], info = {};
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const { p, log } = await open(ctx, base);
    // home-screen icon on the code screen
    const iconGate = await p.evaluate(() => (document.querySelector('link[rel="apple-touch-icon"]') || {}).href || '');
    if (!iconGate) problems.push('the code screen has no home-screen icon');
    else { const r = await ctx.request.get(iconGate); const buf = await r.body(); const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      if (r.status() !== 200 || buf.toString('ascii', 1, 4) !== 'PNG' || w !== 180 || h !== 180) problems.push('the home-screen icon is not a 180x180 PNG'); info.homeScreenIcon = w + 'x' + h; }
    // wrong code, then the right one
    await p.fill('#code', wrong); await p.click('#go');
    await p.waitForFunction(() => /not right/.test((document.getElementById('err') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => problems.push('a wrong code was not refused'));
    await p.fill('#code', code); await p.click('#go');
    await p.waitForSelector('.kpis', { timeout: 60000 }).catch(() => problems.push('Gallup did not open (no overview figures)'));
    await p.waitForTimeout(800);
    const s = await p.evaluate(() => ({
      brand: (document.querySelector('.brand b') || {}).textContent,
      styles: Number(((document.querySelector('.nav a[href="#styles"] .ct') || {}).textContent) || 0),
      local: !!window.__gallupLocal, persistent: window.__gallupLocal && window.__gallupLocal.persistent,
      icon: !!document.querySelector('link[rel="apple-touch-icon"][href="apple-touch-icon.png"]'), appTitle: (document.querySelector('meta[name="apple-mobile-web-app-title"]') || {}).content,
      csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    }));
    if (s.brand !== 'Gallup') problems.push('the Gallup header is missing');
    if (!s.local) problems.push('the website records store did not load');
    if (!s.csp) problems.push('the opened page has no Content Security Policy');
    if (!s.icon || s.appTitle !== 'Gallup') problems.push('the opened app has lost its home-screen icon or title');
    if (data) {
      const season = (data.settings && data.settings.currentSeason) || 'SS27';
      const want = data.collections.styles.filter(x => x.season === season).length;
      if (s.styles !== want) problems.push(`Styles shows ${s.styles} for ${season}, the records file has ${want}`);
      info.records = Object.fromEntries(Object.entries(data.collections).map(([k, v]) => [k, v.length]));
    }
    info.stylesShown = s.styles;
    // add a record, reload, it must still be there
    const title = 'Site check idea ' + Date.now();
    await p.evaluate(() => { location.hash = 'ideas'; });
    await p.click('.bar [data-act="new"][data-k="idea"]');
    await p.fill('#fm-title', title); await p.click('#mSave');
    await p.waitForTimeout(600);
    await p.reload();
    await p.waitForSelector('.kpis, .board', { timeout: 60000 }).catch(() => problems.push('Gallup did not reopen after a reload'));
    await p.evaluate(() => { location.hash = 'ideas'; }); await p.waitForTimeout(600);
    if (!(await p.evaluate(t => document.body.innerText.includes(t), title))) problems.push('a new record was not kept after a reload');
    // export downloads the records
    await p.click('.rail [data-act="settings"]');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }).catch(() => null), p.click('[data-act="export"]')]);
    if (!dl) problems.push('Export records did not download a file');
    else { const j = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); if (j.app !== 'gallup' || !j.collections.ideas.some(i => i.title === title)) problems.push('the export file is missing the new record'); info.export = dl.suggestedFilename(); }
    // Ask Gallup explains it needs Claude
    await p.keyboard.press('Escape'); await p.evaluate(() => { location.hash = 'ask'; }); await p.waitForTimeout(400);
    if (!(await p.evaluate(() => /Claude version/.test(document.body.innerText)))) problems.push('Ask Gallup does not explain that it needs the Claude version');
    info.fontsLoaded = await p.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').length);
    if (!info.fontsLoaded) problems.push('no self-hosted fonts loaded');
    if (log.outside.length) problems.push('requests to other servers: ' + [...new Set(log.outside)].slice(0, 5).join(', '));
    if (log.errs.length) problems.push('page errors: ' + log.errs.slice(0, 3).join(' | '));
    const bad = log.console.filter(t => /integrity|digest|Content Security Policy|Refused to|Failed to load/i.test(t));
    if (bad.length) problems.push('blocked or failed loads: ' + bad.slice(0, 3).join(' | '));
    await ctx.close();

    // tamper test: altered copies of fingerprinted files must be refused
    const t = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const altered = new Set();
    await t.route(/\/(lib\/[^/]+\.js|fonts\/fonts\.css)$/, async r => { altered.add(new URL(r.request().url()).pathname); const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()) + '\n/* altered */' }); });
    const T = await open(t, base);
    await T.p.fill('#code', code); await T.p.click('#go');
    await T.p.waitForTimeout(6000);
    const notRefused = [...altered].filter(f => !T.log.console.some(x => /integrity|digest/i.test(x) && x.includes(f)));
    info.tamperTest = altered.size ? 'altered ' + [...altered].join(', ') + (notRefused.length ? '; NOT refused: ' + notRefused.join(', ') : '; all refused') : 'no fingerprinted file requested';
    if (!altered.size || notRefused.length) problems.push('tamper test failed: ' + info.tamperTest);
    if (T.log.outside.length) problems.push('requests to other servers during tamper test: ' + T.log.outside.slice(0, 3).join(', '));
    await t.close();
  } catch (e) { problems.push(e.message); }
  await b.close(); srv.close();
  console.log((problems.length ? 'FAIL ' : 'PASS ') + JSON.stringify(Object.assign(info, { problems })));
  process.exit(problems.length ? 1 : 0);
})();
