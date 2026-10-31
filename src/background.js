/**
 * Service Worker: reagiert auf Tastenkürzel und Icon-Klick und linted das fokussierte Feld
 * im aktiven Tab.
 *
 * Berechtigungen: nur activeTab + scripting. Beide Auslöser (Kürzel, Icon) erteilen Chrome-seitig
 * eine temporäre Freigabe für genau diesen Tab. Ohne Nutzeraktion kann die Extension nirgends
 * Skripte ausführen.
 */
'use strict';

const COMMAND = 'lint-focused-field';
const INJECTED_FILES = ['src/rules.js', 'src/edits.js', 'src/inject.js'];
const BADGE_DURATION_MS = 2000;
const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === COMMAND) lintTab(tab);
});

chrome.action.onClicked.addListener((tab) => lintTab(tab));

/** @param {chrome.tabs.Tab | undefined} tab */
async function lintTab(tab) {
  if (tab?.id === undefined) return;
  let result;
  try {
    // Läuft in der isolierten Welt der Extension (Standard): Die Seite sieht weder Code noch Daten.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: INJECTED_FILES });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.BrowserLinter.lintFocusedField(),
    });
    result = injection?.result;
  } catch (error) {
    // Erwartbar auf chrome://-Seiten, im Chrome Web Store, im PDF-Viewer usw.
    console.info('[Browser Lint] Seite nicht zugänglich:', error.message);
    result = { status: 'blocked' };
  }
  await showBadge(tab.id, result ?? { status: 'failed' });
}

async function showBadge(tabId, result) {
  const ok = result.status === 'ok';
  const text = ok ? (result.count > 99 ? '99+' : String(result.count)) : result.status === 'no-field' ? '–' : '!';
  const color = ok && result.count > 0 ? '#1a7f37' : ok ? '#59636e' : '#cf222e';
  const title = result.status === 'blocked' ? 'Browser Lint ist auf dieser Seite nicht erlaubt (z. B. chrome://, Web Store)' : DEFAULT_TITLE;
  try {
    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ tabId, color }),
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setTitle({ tabId, title }),
    ]);
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }).catch(() => {});
    }, BADGE_DURATION_MS);
  } catch {
    // Tab wurde inzwischen geschlossen.
  }
}
