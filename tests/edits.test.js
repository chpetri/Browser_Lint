'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeEdits, applyEdits, mapOffset } = require('../src/edits.js');
const { lint } = require('../src/rules.js');

const NBSP = ' ';

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(rand, alphabet, maxLength = 30) {
  let text = '';
  const length = Math.floor(rand() * maxLength);
  for (let i = 0; i < length; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
  return text;
}

describe('computeEdits()', () => {
  it('liefert nichts für identische Texte', () => {
    assert.deepEqual(computeEdits('', ''), []);
    assert.deepEqual(computeEdits('Hallo Welt', 'Hallo Welt'), []);
  });

  it('löscht bei doppelten Leerzeichen das hintere (kollabierte) Zeichen', () => {
    assert.deepEqual(computeEdits('a  b', 'a b'), [{ start: 2, end: 3, text: '' }]);
    assert.deepEqual(computeEdits('a    b', 'a b'), [{ start: 2, end: 5, text: '' }]);
  });

  it('löscht bei „NBSP + Leerzeichen“ das NBSP', () => {
    assert.deepEqual(computeEdits(`a${NBSP} b`, 'a b'), [{ start: 1, end: 2, text: '' }]);
  });

  it('ersetzt Leerraum, der keine Teilfolge ist', () => {
    assert.deepEqual(computeEdits(`a${NBSP}${NBSP}b`, 'a b'), [{ start: 1, end: 3, text: ' ' }]);
  });

  it('ersetzt geänderte Wortteile und behält gemeinsame Enden', () => {
    assert.deepEqual(computeEdits('Moment...', 'Moment…'), [{ start: 6, end: 9, text: '…' }]);
    assert.deepEqual(computeEdits('Ja ... gut', 'Ja … gut'), [{ start: 3, end: 6, text: '…' }]);
  });

  it('löscht bei Leerzeilen die vorderen Umbrüche (Einrückung der nächsten Zeile bleibt)', () => {
    assert.deepEqual(computeEdits('a\n\n\n\nb', 'a\n\nb'), [{ start: 1, end: 3, text: '' }]);
    assert.deepEqual(computeEdits('a\n\n\n\n  b', 'a\n\n  b'), [{ start: 1, end: 3, text: '' }]);
  });

  it('fasst Zeilenende-Leerraum und überzählige Umbrüche zusammen', () => {
    assert.deepEqual(computeEdits('a \n\n\nb', 'a\n\nb'), [{ start: 1, end: 3, text: '' }]);
    assert.deepEqual(computeEdits('-- \n\n\n\nName', '-- \n\nName'), [{ start: 3, end: 5, text: '' }]);
  });

  it('entfernt Leerzeichen vor Satzzeichen', () => {
    assert.deepEqual(computeEdits('Hallo , du', 'Hallo, du'), [{ start: 5, end: 6, text: '' }]);
  });

  it('erfüllt applyEdits(a, computeEdits(a, lint(a))) === lint(a)', () => {
    const rand = random(1);
    const alphabet = ['a', 'Wort', ' ', ' ', NBSP, '\t', '\n', '\n', '.', ',', '!', '?', ':', '`'];
    for (let i = 0; i < 3000; i++) {
      const before = randomText(rand, alphabet);
      const after = lint(before).text;
      assert.equal(applyEdits(before, computeEdits(before, after)), after, JSON.stringify(before));
    }
  });

  it('ist korrekt für beliebige Textpaare (auch ohne Bezug zu den Regeln)', () => {
    const rand = random(2);
    const alphabet = ['a', 'b', 'c', ' ', '\n', NBSP, '.', '…'];
    for (let i = 0; i < 3000; i++) {
      const before = randomText(rand, alphabet);
      const after = randomText(rand, alphabet);
      const edits = computeEdits(before, after);
      assert.equal(applyEdits(before, edits), after, JSON.stringify([before, after]));
      for (let k = 1; k < edits.length; k++) assert.ok(edits[k - 1].end < edits[k].start, 'sortiert, nicht überlappend');
    }
  });
});

describe('mapOffset()', () => {
  const edits = computeEdits('a  b  c', 'a b c'); // löscht Index 2 und 5

  it('verschiebt Positionen hinter Löschungen nach vorn', () => {
    assert.equal(mapOffset(edits, 0), 0);
    assert.equal(mapOffset(edits, 2), 2);
    assert.equal(mapOffset(edits, 4), 3);
    assert.equal(mapOffset(edits, 7), 5);
  });

  it('setzt Positionen innerhalb einer Ersetzung ans Ende der Ersetzung', () => {
    const replaced = computeEdits('x... y', 'x… y');
    assert.equal(mapOffset(replaced, 2), 2);
    assert.equal(mapOffset(replaced, 6), 4);
  });
});
