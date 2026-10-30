#!/usr/bin/env node
/*
 Build the code-protected Gallup website from the Gallup page and a records export.

   ACCESS_CODE=<code> node tools/build_site.js <gallup page .html> <records .json> [out=index.html]

   <gallup page .html>  the Gallup page as published in Claude (the artifact's HTML).
   <records .json>      a Gallup records file: Settings > Export records in Gallup (app "gallup", version 1).

 Safety rules it enforces (the build stops with an error if any fails):
   - Every outside script must be pinned and fingerprinted in tools/libs.json and is replaced by its copy in
     lib/ (Subresource Integrity, sha384); local copies must still match. Gallup currently uses none.
   - Google Fonts are replaced by the self-hosted fonts in fonts/ (fonts.css is fingerprinted).
   - Nothing else may load from another server: no outside stylesheets, scripts, images, frames, @import,
     url(http...) or fetch("http...").
   - The page and the code screen (tools/gate.html) carry a Content Security Policy that only allows this
     site's own files and the page's inline code, and send no referrer.
 The records are bundled into the page with tools/web_shim.js, which keeps edits in each visitor's browser.
 The whole page is gzipped and encrypted with AES-256-GCM (key from the access code via PBKDF2-SHA-256,
 1,000,000 iterations, fresh salt and IV), placed in tools/gate.html, decrypted again to check it, and
 checked for readable record names. The access code is read from the environment only: never put it in a
 file in this repository. Uses only Node's built-in modules.
*/
const crypto = require('crypto'), fs = require('fs'), zlib = require('zlib'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const fail = m => { console.error('build_site: ' + m); process.exit(1); };
const [pagePath, dataPath, outPath = path.join(ROOT, 'index.html')] = process.argv.slice(2);
const code = process.env.ACCESS_CODE;
if (!pagePath || !dataPath) fail('usage: ACCESS_CODE=<code> node tools/build_site.js <gallup page .html> <records .json> [out]');
if (!code) fail('ACCESS_CODE is not set');
if (code.length < 10) fail('ACCESS_CODE is shorter than 10 characters; use a longer random code');
const sri = b => 'sha384-' + crypto.createHash('sha384').update(b).digest('base64');
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
const COLLS = ['ideas', 'styles', 'materials', 'vendors', 'samples', 'changes', 'issues'];

// ---- the page: accept the bare artifact HTML or a full document (keep only what is inside <body>)
let page = fs.readFileSync(pagePath, 'utf8');
const bodyM = page.match(/<body[^>]*>([\s\S]*)<\/body>/i);
if (bodyM) page = bodyM[1];
if (!/<title>Gallup<\/title>/.test(page)) fail('this does not look like the Gallup page (no <title>Gallup</title>)');
if (!/window\.claude/.test(page)) fail('the page no longer reads window.claude; tools/web_shim.js would not apply');

// ---- outside libraries: pinned, fingerprinted local copies only
const libs = JSON.parse(fs.readFileSync(path.join(__dirname, 'libs.json'), 'utf8')).libs || [];
for (const l of libs) if (sri(fs.readFileSync(path.join(ROOT, l.local))) !== l.integrity) fail(l.local + ' does not match its fingerprint in tools/libs.json');
const libsUsed = [];
page = page.replace(/<script\b([^>]*?)\bsrc="(https?:\/\/[^"]+)"([^>]*)>/gi, (m, a, url, b) => {
  const l = libs.find(x => x.urls.includes(url));
  if (!l) fail('outside script without a known fingerprint: ' + url + ' (add a pinned, fingerprinted copy to lib/ and tools/libs.json)');
  libsUsed.push(l.name);
  const rest = (a + ' ' + b).replace(/\s(?:integrity|crossorigin|referrerpolicy)="[^"]*"/gi, '').replace(/\s+/g, ' ').trim();
  return '<script' + (rest ? ' ' + rest : '') + ' src="' + l.local + '" integrity="' + l.integrity + '">';
});

// ---- Google Fonts -> self-hosted, fingerprinted fonts.css
const fontsCss = path.join(ROOT, 'fonts', 'fonts.css');
if (!fs.existsSync(fontsCss)) fail('fonts/fonts.css is missing');
if (/https?:\/\//.test(fs.readFileSync(fontsCss, 'utf8'))) fail('fonts/fonts.css refers to another server');
for (const m of fs.readFileSync(fontsCss, 'utf8').matchAll(/url\(([^)]+)\)/g)) if (!fs.existsSync(path.join(ROOT, 'fonts', m[1].replace(/['"]/g, '')))) fail('fonts/fonts.css refers to a missing file: ' + m[1]);
let fontsUsed = false;
page = page.replace(/<link\b[^>]*href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*>\s*/gi, m => {
  if (!/rel="?stylesheet/i.test(m) || fontsUsed) return '';
  fontsUsed = true;
  return '<link rel="stylesheet" href="fonts/fonts.css" integrity="' + sri(fs.readFileSync(fontsCss)) + '">';
});
if (!fontsUsed) fail('the page no longer loads its fonts from Google Fonts; check the fonts link before publishing');

// ---- the records
let data;
try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); } catch (e) { fail('the records file does not parse: ' + e.message); }
if (!data || data.app !== 'gallup' || typeof data.collections !== 'object') fail('the records file is not a Gallup export (app "gallup")');
const counts = {};
for (const c of COLLS) {
  const rows = data.collections[c];
  if (!Array.isArray(rows)) fail('the records file has no "' + c + '" list');
  for (const r of rows) if (!r || typeof r !== 'object' || !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(String(r.id || ''))) fail('a record in "' + c + '" has no valid id');
  counts[c] = rows.length;
}
if (!counts.styles) fail('the records file has no styles');
const snapshot = { exported: data.exported || new Date().toISOString(), settings: data.settings || null, collections: {} };
for (const c of COLLS) snapshot.collections[c] = data.collections[c];
const LS_ = String.fromCharCode(0x2028), PS_ = String.fromCharCode(0x2029);
const safeJs = s => s.replace(/</g, '\\u003c').split(LS_).join('\\u2028').split(PS_).join('\\u2029');
const shim = fs.readFileSync(path.join(__dirname, 'web_shim.js'), 'utf8');
if (/<\/script/i.test(shim)) fail('tools/web_shim.js must not contain a closing script tag');

// ---- the full page
page = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">\n' +
  '<meta name="referrer" content="no-referrer">\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
  '<meta name="robots" content="noindex,nofollow">\n' +
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,-apple-system,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n' +
  '<script>window.__GALLUP_SNAPSHOT=' + safeJs(JSON.stringify(snapshot)) + ';</script>\n' +
  '<script>\n' + shim + '\n</script>\n</head>\n<body>\n' + page + '\n</body>\n</html>\n';

// ---- nothing may load from another server
const outside = [];
for (const m of page.matchAll(/<(script|link|iframe|frame|img|image|source|video|audio|embed|object|track|use|form)\b[^>]*?\b(?:src|href|data|xlink:href|srcset|action)="\s*(?:https?:)?\/\/[^"]*"[^>]*>/gi)) outside.push(m[0].slice(0, 140));
for (const m of page.matchAll(/@import[^;]*?(?:https?:)?\/\/[^;]*;|url\(\s*['"]?(?:https?:)?\/\/[^)]*\)|fetch\(\s*['"`](?:https?:)?\/\/[^'"`]*|new\s+(?:WebSocket|EventSource)\s*\(/gi)) outside.push(m[0].slice(0, 140));
if (outside.length) fail('the page still loads from other servers:\n  ' + outside.join('\n  '));
if ((page.match(/http-equiv="Content-Security-Policy"/g) || []).length !== 1) fail('the page must carry exactly one Content Security Policy');

// ---- encrypt
const gz = zlib.gzipSync(Buffer.from(page, 'utf8'), { level: 9 });
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iter = 1000000;
const key = crypto.pbkdf2Sync(code, salt, iter, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([c.update(gz), c.final(), c.getAuthTag()]);
const payload = JSON.stringify({ v: 1, iter, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') });

// ---- code screen
const gate = fs.readFileSync(path.join(__dirname, 'gate.html'), 'utf8');
if (gate.split('/*PAYLOAD*/').length !== 2) fail('tools/gate.html must contain /*PAYLOAD*/ exactly once');
if (!gate.includes('content="' + CSP + '"')) fail('tools/gate.html has lost its Content Security Policy');
if (!/name="referrer" content="no-referrer"/.test(gate)) fail('tools/gate.html has lost its no-referrer setting');
if (!/name="robots" content="noindex,nofollow"/.test(gate)) fail('tools/gate.html has lost its noindex setting');
if (/(?:src|href|action)="\s*(?:https?:)?\/\//i.test(gate) || /url\(\s*['"]?(?:https?:)?\/\//i.test(gate)) fail('tools/gate.html loads something from another server');
const out = gate.replace('/*PAYLOAD*/', () => payload);

// ---- self-checks
const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
d.setAuthTag(ct.subarray(ct.length - 16));
if (zlib.gunzipSync(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])).toString('utf8') !== page) fail('self-check failed: decrypting the output does not give back the page');
const names = [];
for (const s of data.collections.styles) if (s.name && s.name.length >= 8) names.push(s.name);
for (const v of data.collections.vendors) if (v.name && v.name.length >= 8) names.push(v.name);
const leaked = names.filter(n => out.includes(n));
if (leaked.length) fail('readable record data found in the output (' + leaked.slice(0, 3).join(', ') + ')');

fs.writeFileSync(outPath, out);

// ---- README date
const readme = path.join(ROOT, 'README.md');
const dt = new Date(snapshot.exported);
if (!isNaN(dt) && fs.existsSync(readme)) {
  const nice = dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const r = fs.readFileSync(readme, 'utf8'), r2 = r.replace(/the Gallup records as of [A-Z][a-z]+ \d{1,2}, \d{4}/, 'the Gallup records as of ' + nice);
  if (r2 !== r) fs.writeFileSync(readme, r2);
}
console.log(JSON.stringify({ ok: true, out: path.relative(process.cwd(), outPath) || outPath, bytes: out.length, records: counts, snapshot: snapshot.exported, fingerprintedLibs: libsUsed, selfHostedFonts: fontsUsed, outsideLoads: 0 }));
