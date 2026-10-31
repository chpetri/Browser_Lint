/**
 * Regel-Engine: reine String-Funktionen ohne DOM-Zugriff.
 *
 * Läuft unverändert in der isolierten Content-Script-Welt (Browser) und in Node (Unit-Tests).
 * Jede Regel ist ein globaler Regex mit konstanter Ersetzung. Kontext wird über
 * Lookarounds geprüft, damit ein Treffer genau die Zeichen umfasst, die ersetzt werden.
 */
'use strict';

(() => {
  /** @typedef {{ id: string, description: string, pattern: RegExp, replacement: string }} Rule */

  /** @type {readonly Rule[]} Reihenfolge ist relevant (z. B. „…“ vor Satzzeichen-Regel). */
  const RULES = Object.freeze(
    [
      {
        id: 'ellipsis',
        description: 'Drei Punkte (...) → Auslassungszeichen (…)',
        // Genau drei Punkte. Längere Punktfolgen („.....“) bleiben unangetastet.
        pattern: /(?<!\.)\.{3}(?!\.)/g,
        replacement: '…',
      },
      {
        id: 'multiple-spaces',
        description: 'Mehrfache Leerzeichen (auch geschützte, NBSP) zwischen Wörtern → ein Leerzeichen',
        // Nur zwischen zwei Nicht-Leerzeichen: Einrückungen am Zeilenanfang bleiben erhalten,
        // Leerraum am Zeilenende übernimmt „trailing-whitespace“. Einzelne NBSP (z. B. „10 €“)
        // und Tabs bleiben, schmale Leerzeichen (U+2009, U+202F) werden nie angefasst.
        pattern: /(?<=\S)[  ]{2,}(?=\S)/g,
        replacement: ' ',
      },
      {
        id: 'space-before-punctuation',
        description: 'Leerzeichen vor . , ; : ! ? entfernen',
        // Das Satzzeichen muss vor Leerraum, Textende oder einem Anführungszeichen stehen.
        // So bleiben „.NET“, „.bashrc“, Smileys wie „:)“ oder „;-)“ und Einrückungen unberührt.
        pattern: /(?<=\S)[ \t ]+(?=[.,;:!?]+(?:[\s"'»«“”‚‘’]|$))/g,
        replacement: '',
      },
      {
        id: 'trailing-whitespace',
        description: 'Leerzeichen am Zeilenende entfernen',
        // Ausnahme: der Signatur-Trenner „-- “ (RFC 3676) braucht sein Leerzeichen.
        pattern: /(?<!^--)[ \t ]+$/gm,
        replacement: '',
      },
      {
        id: 'blank-lines',
        description: 'Mehrere Leerzeilen → genau eine',
        pattern: /\n{3,}/g,
        replacement: '\n\n',
      },
    ].map(Object.freeze),
  );

  // Code bleibt unverändert: Markdown-Codeblöcke (``` oder ~~~) und Inline-Code (`…`).
  const CODE_PATTERN = /(```|~~~)[\s\S]*?\1|`[^`\n]+`/g;

  // Regeln können sich gegenseitig neue Treffer erzeugen (z. B. „a .. .“ → „a...“ → „a…“).
  // Wiederholen bis zum Fixpunkt garantiert Idempotenz; mehr als zwei Durchläufe sind selten.
  const MAX_PASSES = 5;

  /**
   * Wendet eine Regel an und überspringt Treffer, die in geschütztem Code liegen.
   * @param {string} text
   * @param {Rule} rule
   * @returns {{ text: string, count: number }}
   */
  function applyRule(text, rule) {
    const protectedRanges = Array.from(text.matchAll(CODE_PATTERN), (m) => [m.index, m.index + m[0].length]);
    const isProtected = (start, end) => protectedRanges.some(([from, to]) => start < to && from < end);

    let result = '';
    let last = 0;
    let count = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (match[0] === rule.replacement || isProtected(start, end)) continue;
      result += text.slice(last, start) + rule.replacement;
      last = end;
      count++;
    }
    return count === 0 ? { text, count } : { text: result + text.slice(last), count };
  }

  /**
   * Wendet alle Regeln an.
   * @param {string} text
   * @param {readonly Rule[]} [rules]
   * @returns {{ text: string, count: number }} bereinigter Text und Anzahl der Korrekturen
   */
  function lint(text, rules = RULES) {
    let current = text;
    let count = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      for (const rule of rules) {
        const result = applyRule(current, rule);
        if (result.count > 0) {
          current = result.text;
          count += result.count;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return { text: current, count };
  }

  const api = { RULES, applyRule, lint };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.BrowserLinter = Object.assign(globalThis.BrowserLinter ?? {}, api);
})();
