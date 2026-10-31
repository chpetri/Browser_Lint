'use strict';

/**
 * Browser-Tests der DOM-Schicht gegen test-page/index.html (echtes Chromium via Playwright).
 * Die Skripte werden hier per <script> in die Seite geladen. Den Weg über die Extension
 * selbst prüft extension.e2e.test.js.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, INJECTED_FILES, loadChromium } = require('./helpers.js');

const chromium = loadChromium();
const TEST_PAGE = `file://${path.join(ROOT, 'test-page', 'index.html')}`;

describe('DOM-Schicht (inject.js)', { skip: !chromium && 'Playwright nicht installiert' }, () => {
  let browser;
  let page;

  before(async () => {
    browser = await chromium.launch();
  });
  after(() => browser?.close());

  beforeEach(async () => {
    page = await browser.newPage(); // frische Seite = frischer Undo-Stack
    await page.goto(TEST_PAGE);
    for (const file of INJECTED_FILES) await page.addScriptTag({ path: path.join(ROOT, file) });
  });
  afterEach(() => page.close());

  const lint = () => page.evaluate(() => globalThis.BrowserLinter.lintFocusedField());
  const valueOf = (selector) => page.$eval(selector, (el) => (el.isContentEditable ? el.innerHTML : el.value));
  const undo = async () => {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(20); // gruppiertes Undo läuft per setTimeout(0)
  };

  /** Linten, Ergebnis prüfen, zweiter Lauf ändert nichts, ein Strg+Z stellt das Original her. */
  async function expectLint(selector, expected, count) {
    await page.click(selector);
    const original = await valueOf(selector);
    assert.deepEqual(await lint(), { status: 'ok', count, ...(selector.includes('ce-') ? { skipped: 0 } : {}) });
    assert.equal(await valueOf(selector), expected);
    assert.equal((await lint()).count, 0, 'zweiter Lauf ist ein No-op');
    await undo();
    assert.equal(await valueOf(selector), original, 'ein Strg+Z stellt das Original her');
  }

  it('textarea: alle Regeln, Undo', async () => {
    await expectLint('#textarea', 'Hallo Team,\n\nich habe das Dokument angehängt.\n\nBitte prüft es bis Freitag …\nDanke!', 6);
  });

  it('input type=text: Regeln, Undo', async () => {
    await expectLint('#input-text', 'Kurzer Betreff, bitte lesen!', 4);
  });

  it('input type=email: ohne Selection-API, ohne Fehler', async () => {
    await page.click('#input-email');
    assert.deepEqual(await lint(), { status: 'ok', count: 0 });
  });

  it('input type=password wird nie angefasst', async () => {
    await page.click('#input-password');
    assert.deepEqual(await lint(), { status: 'unsupported' });
    assert.equal(await valueOf('#input-password'), 'geheim  passwort ...');
  });

  it('readonly-Felder werden nicht verändert', async () => {
    await page.click('#readonly');
    assert.deepEqual(await lint(), { status: 'readonly' });
    assert.equal(await valueOf('#readonly'), 'Nur  lesen ,  bitte .');
  });

  it('kontrolliertes Feld (React-Logik): Framework-State zieht mit', async () => {
    await page.click('#react-like');
    assert.deepEqual(await lint(), { status: 'ok', count: 3 });
    assert.equal(await page.$eval('#react-state', (el) => el.textContent), 'State: "State muss mitziehen!"');
  });

  it('contenteditable wie Gmail: Struktur bleibt, Leerzeilen per Blocklöschung, ein Undo', async () => {
    await expectLint(
      '#ce-gmail',
      'Hallo Anna,<div><br></div><div>anbei die Unterlagen.</div><div><br></div><div>Viele Grüße …</div>',
      6,
    );
  });

  it('contenteditable: Redo stellt die Korrektur in einem Schritt wieder her', async () => {
    await page.click('#ce-gmail');
    await lint();
    const fixed = await valueOf('#ce-gmail');
    await undo();
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(20);
    assert.equal(await valueOf('#ce-gmail'), fixed);
  });

  it('contenteditable mit Formatierung: <b>/<i> bleiben, Code/Zitat/Chip unverändert', async () => {
    await expectLint(
      '#ce-rich',
      '<p>Das ist <b>wichtig&nbsp;</b>und <i>dringend</i>!</p>' +
        '<p>Code bleibt: <code>a  =  b...</code></p>' +
        '<blockquote>Zitat&nbsp; bleibt  ,  wie es ist .</blockquote>' +
        '<p>Danke <span class="chip" contenteditable="false">@Max  Muster</span>, bis bald …</p>',
      4,
    );
  });

  it('contenteditable: Leerzeilen direkt nach Text, <br> im Block, Listen bleiben', async () => {
    await page.click('#ce-mixed');
    const original = await valueOf('#ce-mixed');
    assert.deepEqual(await lint(), { status: 'ok', count: 6, skipped: 1 }); // leere Listenpunkte bleiben
    assert.equal(
      await valueOf('#ce-mixed'),
      'Hallo<div><br></div><div><b>Fett&nbsp;</b>Text<br>Zweite Zeile …</div>' +
        '<ul><li>Punkt eins,</li><li><br></li><li><br></li><li><br></li><li>Punkt zwei</li></ul>',
    );
    await undo();
    assert.equal(await valueOf('#ce-mixed'), original);
  });

  it('iframe mit designMode (gleicher Origin)', async () => {
    const frame = await (await page.$('#frame')).contentFrame();
    await frame.waitForFunction(() => document.designMode === 'on');
    await page.click('#frame');
    const original = await frame.$eval('body', (el) => el.innerHTML);
    assert.deepEqual(await lint(), { status: 'ok', count: 4, skipped: 0 });
    assert.equal(await frame.$eval('body', (el) => el.innerHTML), 'Text im iframe,<br><br>mit Leerzeilen …');
    await undo();
    assert.equal(await frame.$eval('body', (el) => el.innerHTML), original);
  });

  it('ohne fokussiertes Feld: Hinweis statt Änderung', async () => {
    await page.click('h1');
    assert.deepEqual(await lint(), { status: 'no-field' });
    assert.equal(await page.locator('browser-linter-toast').count(), 1, 'Toast wird angezeigt');
  });

  it('Sicherheitsnetz: unerwartete Änderung → alles zurückgerollt', async () => {
    await page.click('#ce-gmail');
    const original = await valueOf('#ce-gmail');
    // Simuliert einen Editor, der Eingaben verfälscht (fügt Text ein statt zu löschen).
    await page.evaluate(() => {
      const native = document.execCommand.bind(document);
      document.execCommand = (cmd, ui, value) => native(cmd, ui, cmd === 'insertText' ? `${value}X` : value);
    });
    assert.deepEqual(await lint(), { status: 'error' });
    assert.equal(await valueOf('#ce-gmail'), original);
  });

  it('Editor mit eigenem Undo (preventDefault): kein zusätzliches Rückgängigmachen', async () => {
    await page.click('#ce-gmail');
    await lint();
    const fixed = await valueOf('#ce-gmail');
    await page.$eval('#ce-gmail', (el) =>
      el.addEventListener('beforeinput', (e) => e.inputType === 'historyUndo' && e.preventDefault()),
    );
    await undo();
    assert.equal(await valueOf('#ce-gmail'), fixed);
  });
});
