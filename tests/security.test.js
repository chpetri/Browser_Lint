'use strict';

/**
 * Statische Prüfungen der Akzeptanzkriterien „minimale Berechtigungen“ und
 * „kein Netzwerk, keine Telemetrie, kein innerHTML/eval“.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const sources = fs
  .readdirSync(path.join(ROOT, 'src'))
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ file, code: fs.readFileSync(path.join(ROOT, 'src', file), 'utf8') }));

describe('manifest.json', () => {
  it('ist Manifest V3', () => {
    assert.equal(manifest.manifest_version, 3);
  });

  it('fordert ausschließlich activeTab und scripting an', () => {
    assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting']);
  });

  it('hat keine Host-Rechte, keine Content Scripts und keine von außen erreichbaren Ressourcen', () => {
    for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions', 'content_scripts',
      'web_accessible_resources', 'externally_connectable']) {
      assert.equal(manifest[key], undefined, key);
    }
  });

  it('lockert die Standard-CSP nicht', () => {
    assert.equal(manifest.content_security_policy, undefined);
  });

  it('definiert das Tastenkürzel Alt+Shift+L', () => {
    assert.equal(manifest.commands['lint-focused-field'].suggested_key.default, 'Alt+Shift+L');
  });

  it('verweist nur auf existierende Dateien', () => {
    const files = [manifest.background.service_worker, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
    for (const file of files) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  });

  it('hält die Store-Grenze für die Beschreibung ein (132 Zeichen)', () => {
    assert.ok(manifest.description.length <= 132);
  });
});

describe('Quellcode in src/', () => {
  const forbidden = [
    [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/, 'HTML-Sinks (XSS)'],
    [/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/, 'dynamische Code-Ausführung'],
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.connection/, 'Netzwerkzugriff'],
    [/chrome\.storage|localStorage|indexedDB|document\.cookie/, 'Datenspeicherung'],
    [/https?:\/\//, 'externe URLs'],
  ];

  for (const [pattern, label] of forbidden) {
    it(`enthält keine ${label}`, () => {
      for (const { file, code } of sources) assert.doesNotMatch(code, pattern, `${file}: ${label}`);
    });
  }
});
