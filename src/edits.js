/**
 * Übersetzt „Text vorher → Text nachher“ in minimale Ersetzungen (Edits).
 *
 * Reine Funktionen ohne DOM-Zugriff. Der DOM-Code braucht Edits statt des fertigen Texts,
 * weil er in contenteditable nur die betroffenen Stellen ersetzen darf. Sonst gingen
 * Formatierung und Undo verloren.
 */
'use strict';

(() => {
  /** @typedef {{ start: number, end: number, text: string }} Edit  Offsets beziehen sich auf den Originaltext. */

  const isWhitespace = (ch) => /\s/.test(ch);

  /**
   * Berechnet Edits, die `before` in `after` überführen. Funktioniert für beliebige Paare und
   * ist minimal für lokale Änderungen, wie sie die Regeln erzeugen (Leerraum kürzen,
   * einzelne Wörter ersetzen). Wörter und Leerraumfolgen werden abwechselnd verglichen.
   *
   * @param {string} before
   * @param {string} after
   * @returns {Edit[]} aufsteigend sortiert, nicht überlappend
   */
  function computeEdits(before, after) {
    /** @type {Edit[]} */
    const edits = [];
    const add = (start, end, text) => {
      if (start === end && text === '') return;
      const last = edits[edits.length - 1];
      if (last && last.end === start) {
        last.end = end;
        last.text += text;
      } else {
        edits.push({ start, end, text });
      }
    };

    let i = 0;
    let j = 0;
    while (i < before.length || j < after.length) {
      const runStartI = i;
      const runStartJ = j;
      while (i < before.length && isWhitespace(before[i])) i++;
      while (j < after.length && isWhitespace(after[j])) j++;
      diffWhitespaceRun(before.slice(runStartI, i), after.slice(runStartJ, j), runStartI, add);

      if (i === before.length && j === after.length) break;
      if (before[i] === after[j]) {
        i++;
        j++;
        continue;
      }
      // Wort unterscheidet sich: bis zum nächsten Leerraum vergleichen, gemeinsames Ende behalten.
      let iEnd = i;
      let jEnd = j;
      while (iEnd < before.length && !isWhitespace(before[iEnd])) iEnd++;
      while (jEnd < after.length && !isWhitespace(after[jEnd])) jEnd++;
      while (iEnd > i && jEnd > j && before[iEnd - 1] === after[jEnd - 1]) {
        iEnd--;
        jEnd--;
      }
      add(i, iEnd, after.slice(j, jEnd));
      i = iEnd;
      j = jEnd;
    }
    return edits;
  }

  /**
   * Vergleicht zwei Leerraumfolgen. Für contenteditable ist entscheidend, *welche* Zeichen
   * gelöscht werden, auch wenn das Ergebnis als String gleich ist (im Browser getestet):
   *  - Leerzeichen: die vorderen behalten. Bei „a␣␣b“ ist nur das erste sichtbar, das zweite
   *    kollabiert. Nur dessen Löschung setzt der Browser sauber um.
   *  - Zeilenumbrüche: die hinteren behalten, die vorderen löschen. Die Auswahl beginnt dann
   *    direkt hinter Text und endet in einer leeren Zeile. So wird kein Absatz mit Inhalt
   *    verschoben (das quittiert Chrome mit Style-<span>s), und leere Zeilen behalten ihr <br>.
   */
  function diffWhitespaceRun(run, target, offset, add) {
    if (run === target) return;
    // Aufteilen in „bis einschließlich letztem Umbruch“ und „Einrückung der nächsten Zeile“.
    const targetSplit = target.lastIndexOf('\n') + 1;
    const runSplit = run.lastIndexOf('\n') + 1;
    const head = matchSubsequence(run, target.slice(0, targetSplit), 0, runSplit, true);
    const tail = matchSubsequence(run, target.slice(targetSplit), runSplit, run.length, false);

    if (head && tail) {
      const kept = new Set([...head, ...tail]);
      for (let p = 0; p < run.length; p++) {
        if (!kept.has(p)) add(offset + p, offset + p + 1, '');
      }
      return;
    }
    // `target` ist keine Teilfolge (z. B. NBSP NBSP → Leerzeichen): Mitte ersetzen.
    let start = 0;
    let endRun = run.length;
    let endTarget = target.length;
    while (start < endRun && start < endTarget && run[start] === target[start]) start++;
    while (endRun > start && endTarget > start && run[endRun - 1] === target[endTarget - 1]) {
      endRun--;
      endTarget--;
    }
    add(offset + start, offset + endRun, target.slice(start, endTarget));
  }

  /**
   * Sucht `target` als Teilfolge in run[from, to). `latest`: Treffer so weit hinten wie möglich.
   * @returns {number[] | null} behaltene Indizes in `run`
   */
  function matchSubsequence(run, target, from, to, latest) {
    const kept = [];
    if (latest) {
      let k = to - 1;
      for (let t = target.length - 1; t >= 0; t--, k--) {
        while (k >= from && run[k] !== target[t]) k--;
        if (k < from) return null;
        kept.push(k);
      }
    } else {
      let k = from;
      for (let t = 0; t < target.length; t++, k++) {
        while (k < to && run[k] !== target[t]) k++;
        if (k >= to) return null;
        kept.push(k);
      }
    }
    return kept;
  }

  /** @param {string} text @param {Edit[]} edits */
  function applyEdits(text, edits) {
    let result = '';
    let last = 0;
    for (const edit of edits) {
      result += text.slice(last, edit.start) + edit.text;
      last = edit.end;
    }
    return result + text.slice(last);
  }

  /**
   * Rechnet eine Cursorposition aus dem Originaltext in den bearbeiteten Text um.
   * @param {Edit[]} edits
   * @param {number} offset
   */
  function mapOffset(edits, offset) {
    let delta = 0;
    for (const edit of edits) {
      if (edit.end <= offset) delta += edit.text.length - (edit.end - edit.start);
      else if (edit.start < offset) return edit.start + delta + edit.text.length;
      else break;
    }
    return offset + delta;
  }

  const api = { computeEdits, applyEdits, mapOffset };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.BrowserLinter = Object.assign(globalThis.BrowserLinter ?? {}, api);
})();
