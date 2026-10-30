#!/usr/bin/env node
/*
 Render the home-screen and browser icons from tools/logo.svg (the Gallup horse).
   node tools/make_icons.js
 Writes apple-touch-icon.png (180x180, the icon iPhone and iPad use for "Add to Home Screen"; square and
 opaque, iOS rounds the corners itself) and favicon-32.png. Needs Playwright.
*/
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const logo = fs.readFileSync(path.join(__dirname, 'logo.svg'), 'utf8');
const page = (size, pct, radius) => `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:${size}px;height:${size}px;background:#FFFFFF;border-radius:${radius}px;display:grid;place-items:center">
<div style="width:${pct}%;line-height:0;transform:translateY(${size * 0.015}px)">${logo.replace('<svg ', '<svg style="width:100%;height:auto;display:block" ')}</div></div></body></html>`;
(async () => {
  const b = await chromium.launch();
  for (const [file, size, pct, radius] of [['apple-touch-icon.png', 180, 78, 0], ['favicon-32.png', 32, 84, 7]]) {
    const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await p.setContent(page(size, pct, radius));
    await p.screenshot({ path: path.join(ROOT, file), omitBackground: radius > 0, clip: { x: 0, y: 0, width: size, height: size } });
    await p.close();
  }
  await b.close();
  console.log('wrote apple-touch-icon.png (180x180) and favicon-32.png');
})();
