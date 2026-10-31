'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..', '..');
const INJECTED_FILES = ['src/rules.js', 'src/edits.js', 'src/inject.js'];

/** Playwright ist optional (keine Abhängigkeit im Repo). Ohne Playwright werden die Tests übersprungen. */
function loadChromium() {
  try {
    return require('playwright').chromium;
  } catch {
    return null;
  }
}

/** Minimaler statischer Server für test-page/ (nur 127.0.0.1, nur GET). Port 0 = zufällig. */
function serveTestPage(port = 0) {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, 'test-page', 'index.html');
    if (req.method !== 'GET' || !['/', '/index.html'].includes(new URL(req.url, 'http://x').pathname)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/**
 * Kopiert die Extension in ein Temp-Verzeichnis und passt dort das Manifest an.
 * Das ausgelieferte manifest.json bleibt unverändert.
 */
function copyExtension(patchManifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lint-'));
  for (const entry of ['src', 'icons']) fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(patchManifest(manifest), null, 2));
  return dir;
}

async function launchWithExtension(chromium, extensionDir) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // neuer Headless-Modus, der Extensions unterstützt
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker };
}

module.exports = { ROOT, INJECTED_FILES, loadChromium, serveTestPage, copyExtension, launchWithExtension };
