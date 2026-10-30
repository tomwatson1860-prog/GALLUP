# Gallup

Website: https://tomwatson1860-prog.github.io/GALLUP/

Gallup is a product lifecycle management (PLM) app for an apparel business that designs, merchandises and sells clothing made by outside vendors. It covers ideas, styles (bill of materials, graded specs, colorways, quality tests, costing, calendar), materials, vendors, samples, quality feedback and change orders, plus a process map of the six lifecycle gates.

The site asks for an access code. The app and its records are stored in `index.html` in encrypted form (AES-256-GCM, with the key derived from the access code) and are decrypted in the visitor's browser, so this repository holds no readable copy of them. Ask the owner for the code.

This copy starts from the Gallup records as of October 30, 2026.

## How records work on the website

- Records start from the copy bundled into the page. Each visitor's changes are saved in their own browser (`localStorage`), not on a server, so they are not shared with other people.
- **Settings › Export records** saves every record to a `.json` file, and **Import from file** loads one. Use these to keep a backup, move records to another browser, or carry them back into the Claude version of Gallup.
- **Ask Gallup** needs Claude, so it only works in the Claude version. Everything else works here.
- Records saved in a browser are stored there unencrypted. Use a device and browser profile you trust.

## Updating the site

Rebuild it from the Gallup page published in Claude and a records file made with **Settings › Export records**:

```
ACCESS_CODE=<code> node tools/build_site.js <gallup page .html> <gallup-records.json> index.html
ACCESS_CODE=<code> node tools/check_site.js index.html <gallup-records.json>
```

`build_site.js` applies the safety rules below, bundles the records into the page with `tools/web_shim.js`, encrypts it into the code screen in `tools/gate.html`, decrypts its own output to check it, checks that no readable record names are left, and updates the date above. `check_site.js` opens the result in a headless browser served from `127.0.0.1`. It passes only when all of these hold:

- A wrong code is refused and the right code opens Gallup.
- The bundled records show.
- A new record survives a reload, and Export records downloads it.
- Nothing loads from other servers.
- An altered copy of the fingerprinted font stylesheet is refused.

GitHub Pages publishes the `gh-pages` branch. Commit to `main` and push it to both branches (`git push origin main main:gh-pages`).

The access code is never stored in this repository. Never commit a records file either: it is readable.

## Safety

- Everything the page needs is served from this site. The fonts (Archivo, Source Sans 3, IBM Plex Mono; latin and latin-ext only) are in `fonts/` with their licences, and `fonts/fonts.css` is fingerprinted (Subresource Integrity, SHA-384), so a browser refuses an altered copy. Gallup uses no outside script libraries; `tools/libs.json` lists none, and the build stops if the page tries to load one.
- The code screen and the app set a Content Security Policy that blocks loading anything from other servers, and send no referrer when visitors follow a link out. Search engines are asked not to index the site.
- No cookies, analytics or forms that send data. The access code is checked in the visitor's browser and never leaves it.
- A code screen only keeps out people who don't have the code. Anyone can save the page and try codes offline, so the code must be long and random, and it should be changed (by rebuilding with a new code) if it is shared too widely.
