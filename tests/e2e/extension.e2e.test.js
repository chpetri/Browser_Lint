'use strict';

/**
 * Lädt die echte Extension in Chromium und prüft Kürzel, Service Worker, Injektion und Badge.
 *
 * Tastenkürzel lassen sich per Automatisierung nicht auslösen (Chrome verarbeitet sie außerhalb
 * der Seite), und activeTab wird nur durch echte Nutzeraktionen erteilt. Für den Durchlauf-Test
 * bekommt deshalb eine *Kopie* der Extension Host-Rechte für den lokalen Testserver.
 * Das ausgelieferte Manifest bleibt bei activeTab + scripting.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadChromium, serveTestPage, copyExtension, launchWithExtension, ROOT } = require('./helpers.js');

const chromium = loadChromium();

describe('Extension in Chromium', { skip: !chromium && 'Playwright nicht installiert' }, () => {
  it('registriert Alt+Shift+L als Tastenkürzel', async () => {
    const { context, worker } = await launchWithExtension(chromium, ROOT);
    try {
      const commands = await worker.evaluate(() => chrome.commands.getAll());
      assert.deepEqual(commands.find((c) => c.name === 'lint-focused-field')?.shortcut, 'Alt+Shift+L');
    } finally {
      await context.close();
    }
  });

  it('dokumentiert: Chrome vergibt Ctrl+S nicht als vorgeschlagenes Kürzel', async () => {
    const dir = copyExtension((m) => ({
      ...m,
      commands: { 'lint-focused-field': { ...m.commands['lint-focused-field'], suggested_key: { default: 'Ctrl+S' } } },
    }));
    const { context, worker } = await launchWithExtension(chromium, dir);
    try {
      const commands = await worker.evaluate(() => chrome.commands.getAll());
      assert.equal(commands.find((c) => c.name === 'lint-focused-field')?.shortcut, '');
    } finally {
      await context.close();
    }
  });

  describe('Durchlauf: Service Worker → Injektion → Ergebnis → Badge', () => {
    let server;
    let context;
    let worker;
    let page;

    before(async () => {
      const served = await serveTestPage();
      server = served.server;
      const dir = copyExtension((m) => ({ ...m, host_permissions: ['http://127.0.0.1/*'] }));
      ({ context, worker } = await launchWithExtension(chromium, dir));
      page = await context.newPage();
      await page.goto(served.url);
    });

    after(async () => {
      await context?.close();
      server?.close();
    });

    const lintActiveTab = () =>
      worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
        await lintTab(tab); // globale Funktion aus src/background.js
        return chrome.action.getBadgeText({ tabId: tab.id });
      });

    it('bereinigt die fokussierte textarea und zeigt die Anzahl im Badge', async () => {
      await page.click('#textarea');
      assert.equal(await lintActiveTab(), '6');
      assert.equal(
        await page.$eval('#textarea', (el) => el.value),
        'Hallo Team,\n\nich habe das Dokument angehängt.\n\nBitte prüft es bis Freitag …\nDanke!',
      );
    });

    it('läuft in der isolierten Welt: die Seite sieht keine Extension-Objekte', async () => {
      assert.equal(await page.evaluate(() => typeof globalThis.BrowserLinter), 'undefined');
    });

    it('zeigt „–“, wenn kein Textfeld fokussiert ist', async () => {
      await page.click('h1');
      assert.equal(await lintActiveTab(), '–');
    });
  });
});
