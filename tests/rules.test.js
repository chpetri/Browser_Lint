'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RULES, applyRule, lint } = require('../src/rules.js');

const NBSP = ' ';

/** Wendet genau eine Regel an (isoliert von den anderen). */
function fix(ruleId, text) {
  const rule = RULES.find((r) => r.id === ruleId);
  assert.ok(rule, `Regel ${ruleId} existiert`);
  return applyRule(text, rule).text;
}

/** Kleiner deterministischer Zufallsgenerator (mulberry32), damit Fuzz-Tests reproduzierbar sind. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(rand, maxLength = 40) {
  const alphabet = ['a', 'b', 'Wort', ' ', ' ', NBSP, '\t', '\n', '.', ',', '!', '?', ':', ';', '`', '-', ')', '„', '“'];
  let text = '';
  const length = Math.floor(rand() * maxLength);
  for (let i = 0; i < length; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
  return text;
}

describe('Regel: multiple-spaces', () => {
  it('reduziert mehrfache Leerzeichen auf eines', () => {
    assert.equal(fix('multiple-spaces', 'Hallo  Welt'), 'Hallo Welt');
    assert.equal(fix('multiple-spaces', 'a     b  c'), 'a b c');
  });

  it('behandelt geschützte Leerzeichen (NBSP) wie Leerzeichen', () => {
    assert.equal(fix('multiple-spaces', `Hallo${NBSP} Welt`), 'Hallo Welt');
    assert.equal(fix('multiple-spaces', `Hallo ${NBSP}Welt`), 'Hallo Welt');
    assert.equal(fix('multiple-spaces', `Hallo${NBSP}${NBSP}Welt`), 'Hallo Welt');
  });

  it('lässt einzelne NBSP, Tabs und Einrückungen stehen', () => {
    assert.equal(fix('multiple-spaces', `10${NBSP}€`), `10${NBSP}€`);
    assert.equal(fix('multiple-spaces', 'Spalte\t\tWert'), 'Spalte\t\tWert');
    assert.equal(fix('multiple-spaces', '  - Punkt\n    - Unterpunkt'), '  - Punkt\n    - Unterpunkt');
  });

  it('greift nicht über Zeilenumbrüche hinweg', () => {
    assert.equal(fix('multiple-spaces', 'a  \n  b'), 'a  \n  b');
  });
});

describe('Regel: space-before-punctuation', () => {
  it('entfernt Leerzeichen vor Satzzeichen', () => {
    assert.equal(fix('space-before-punctuation', 'Hallo , Welt'), 'Hallo, Welt');
    assert.equal(fix('space-before-punctuation', 'Ende .'), 'Ende.');
    assert.equal(fix('space-before-punctuation', 'Wirklich ?!'), 'Wirklich?!');
    assert.equal(fix('space-before-punctuation', 'Liste :\n- a'), 'Liste:\n- a');
    assert.equal(fix('space-before-punctuation', 'erstens ; zweitens'), 'erstens; zweitens');
    assert.equal(fix('space-before-punctuation', `Danke${NBSP}!`), 'Danke!');
    assert.equal(fix('space-before-punctuation', 'Er sagte „Hallo“ .'), 'Er sagte „Hallo“.');
  });

  it('lässt Dateinamen, Smileys und Einrückungen in Ruhe', () => {
    for (const text of ['Ich nutze .NET', 'Datei .bashrc', 'Super :)', 'Na ;-)', 'Haha :D', '  . eingerückt', 'Anstoß 10 :30']) {
      assert.equal(fix('space-before-punctuation', text), text, text);
    }
  });
});

describe('Regel: trailing-whitespace', () => {
  it('entfernt Leerraum am Zeilenende (Leerzeichen, Tab, NBSP)', () => {
    assert.equal(fix('trailing-whitespace', `a  \nb\t\nc${NBSP}\nd `), 'a\nb\nc\nd');
  });

  it('leert Zeilen, die nur aus Leerraum bestehen', () => {
    assert.equal(fix('trailing-whitespace', 'a\n   \nb'), 'a\n\nb');
  });

  it('respektiert den Signatur-Trenner „-- “', () => {
    assert.equal(fix('trailing-whitespace', 'Gruß\n-- \nMax'), 'Gruß\n-- \nMax');
  });
});

describe('Regel: blank-lines', () => {
  it('reduziert mehrere Leerzeilen auf genau eine', () => {
    assert.equal(fix('blank-lines', 'a\n\n\nb'), 'a\n\nb');
    assert.equal(fix('blank-lines', 'a\n\n\n\n\n\nb'), 'a\n\nb');
  });

  it('lässt einzelne Leerzeilen und Zeilenumbrüche stehen', () => {
    assert.equal(fix('blank-lines', 'a\nb\n\nc'), 'a\nb\n\nc');
  });
});

describe('Regel: ellipsis', () => {
  it('ersetzt drei Punkte durch das Auslassungszeichen', () => {
    assert.equal(fix('ellipsis', 'Moment...'), 'Moment…');
    assert.equal(fix('ellipsis', 'Ja ... und dann'), 'Ja … und dann');
  });

  it('lässt zwei oder mehr als drei Punkte stehen', () => {
    assert.equal(fix('ellipsis', 'a.. b'), 'a.. b');
    assert.equal(fix('ellipsis', 'Trenner ....'), 'Trenner ....');
  });
});

describe('lint()', () => {
  it('liefert für den leeren String nichts', () => {
    assert.deepEqual(lint(''), { text: '', count: 0 });
  });

  it('lässt sauberen Text unverändert', () => {
    const clean = 'Hallo Anna,\n\nanbei die Unterlagen. Bis Freitag …\n\nViele Grüße';
    assert.deepEqual(lint(clean), { text: clean, count: 0 });
  });

  it('wendet alle Regeln an und zählt die Korrekturen', () => {
    const input = `Hallo${NBSP} Anna ,  \n\n\n\nanbei die Unterlagen .\nBis Freitag ...`;
    assert.deepEqual(lint(input), {
      text: 'Hallo Anna,\n\nanbei die Unterlagen.\nBis Freitag …',
      count: 6, // NBSP-Doppel, „ ,“, Zeilenende, Leerzeilen, „ .“, „...“
    });
  });

  it('setzt „…“ vor die Satzzeichen-Regel (Leerzeichen vor „…“ bleibt)', () => {
    assert.equal(lint('Was ist ... ?').text, 'Was ist …?');
  });

  it('verändert keinen Code (Inline und Codeblöcke)', () => {
    const input = 'Nutze `a  =  b...` hier .\n\n```\nfoo(...args)  ;\n\n\n\nbar ;\n```\n';
    assert.equal(lint(input).text, 'Nutze `a  =  b...` hier.\n\n```\nfoo(...args)  ;\n\n\n\nbar ;\n```\n');
  });

  it('ist idempotent: ein zweiter Lauf ändert nichts mehr', () => {
    const rand = random(42);
    for (let i = 0; i < 3000; i++) {
      const once = lint(randomText(rand)).text;
      const twice = lint(once);
      assert.deepEqual(twice, { text: once, count: 0 }, JSON.stringify(once));
    }
  });

  it('erreicht den Fixpunkt auch bei sich gegenseitig auslösenden Regeln', () => {
    assert.deepEqual(lint('a .. .'), { text: 'a…', count: 3 });
  });

  it('entfernt nur Leerraum oder ersetzt „...“ (Nicht-Leerraum bleibt erhalten)', () => {
    const rand = random(7);
    const skeleton = (s) => s.replace(/\s/g, '').replaceAll('...', '…');
    for (let i = 0; i < 3000; i++) {
      const input = randomText(rand);
      assert.equal(skeleton(lint(input).text), skeleton(input), JSON.stringify(input));
    }
  });
});

describe('RULES', () => {
  it('hat eindeutige IDs, Beschreibungen und globale Regexe', () => {
    assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
    for (const rule of RULES) {
      assert.ok(rule.description.length > 0);
      assert.ok(rule.pattern.global, `${rule.id} braucht das g-Flag`);
      assert.ok(Object.isFrozen(rule));
    }
  });
});
