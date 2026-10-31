/**
 * DOM-Schicht: fokussiertes Feld finden, Text holen, Regeln anwenden, zurückschreiben, Toast.
 *
 * Wird per chrome.scripting.executeScript in die *isolierte* Welt des aktiven Tabs injiziert
 * (nach rules.js und edits.js). Die Seite sieht diese Funktionen nicht und kann sie nicht
 * manipulieren. Kein innerHTML, kein eval, kein Netzwerk.
 *
 * Schreibweg: document.execCommand('insertText'). Das ist zwar „deprecated“, aber der einzige
 * Weg, der in Chrome den Undo-Stack erhält und echte input-/beforeinput-Events auslöst, auf die
 * React, Vue und Editor-Frameworks reagieren.
 */
'use strict';

(() => {
  const { lint, computeEdits, mapOffset } = globalThis.BrowserLinter;

  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url']);
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  // --- contenteditable: Textmodell -------------------------------------------------------------

  // Elemente, die eine eigene Zeile bilden.
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
  ]);
  // Inhalt bleibt unverändert (Code, Zitate, Tabellen, eingebettete Objekte).
  const VERBATIM_TAGS = new Set([
    'pre', 'code', 'kbd', 'samp', 'blockquote', 'table', 'textarea', 'input', 'select', 'button',
    'img', 'svg', 'math', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed',
  ]);
  const INVISIBLE_TAGS = new Set(['script', 'style', 'template', 'noscript']);
  // Nur Zeilenumbrüche aus diesen Quellen dürfen gelöscht werden (Leerzeilen-Regel).
  // Leere Listenpunkte, Überschriften usw. bleiben.
  const MERGEABLE_BLOCKS = new Set(['div', 'p']);
  // Platzhalter für unveränderlichen Inhalt. Für die Regeln ist das ein normales Zeichen.
  const OPAQUE_CHAR = '￼';

  /**
   * Bildet den sichtbaren Text eines contenteditable-Bereichs als String ab. Jedes Zeichen
   * gehört zu einem Segment:
   *  - 'text':   Zeichen eines Textknotens (Offset 1:1)
   *  - 'break':  virtueller Zeilenumbruch aus <br> oder einer Blockgrenze
   *  - 'opaque': unveränderlicher Inhalt (Code, Zitat, contenteditable=false …)
   * Für 'break'/'opaque' merken wir die DOM-Positionen davor und danach.
   *
   * Leere Zeilen in Gmail und Outlook sehen so aus: <div><br></div>. Das <br> am Blockende ist
   * nur ein Platzhalter. Den Umbruch liefert die Blockgrenze.
   */
  function buildModel(root) {
    const segments = [];
    let text = '';
    let emptyLinePending = false;

    const emit = (str, segment) => {
      segments.push({ start: text.length, end: text.length + str.length, ...segment });
      text += str;
    };
    const lineBreak = (before, after, mergeable) => {
      emit('\n', { kind: 'break', before, after, mergeable });
      emptyLinePending = false;
    };
    const needsBreak = () => emptyLinePending || (text !== '' && !text.endsWith('\n'));

    const walk = (parent) => {
      let index = 0;
      for (let node = parent.firstChild; node; node = node.nextSibling, index++) {
        if (node.nodeType === TEXT_NODE) {
          const data = renderedText(node);
          if (data) emit(data, { kind: 'text', node });
          continue;
        }
        if (node.nodeType !== ELEMENT_NODE) continue;
        const name = node.localName;
        if (INVISIBLE_TAGS.has(name)) continue;

        if (name === 'br') {
          if (!isTrailingBr(node, root)) lineBreak([parent, index], [parent, index + 1], true);
          else if (text === '' || text.endsWith('\n')) emptyLinePending = true;
          continue;
        }

        const isBlock = BLOCK_TAGS.has(name);
        const mergeable = MERGEABLE_BLOCKS.has(name);
        if (isBlock && needsBreak()) lineBreak([parent, index], [node, 0], mergeable);
        if (VERBATIM_TAGS.has(name) || !node.isContentEditable) {
          emit(OPAQUE_CHAR, { kind: 'opaque', before: [parent, index], after: [parent, index + 1] });
        } else {
          walk(node);
        }
        if (isBlock && needsBreak()) lineBreak([node, node.childNodes.length], [parent, index + 1], mergeable);
      }
    };

    walk(root);
    return { text, segments };
  }

  /** Text eines Textknotens, wie er dargestellt wird (Quelltext-Umbrüche kollabieren). */
  function renderedText(node) {
    const data = node.data;
    if (!/[\n\r\t]/.test(data) || preservesWhitespace(node.parentElement)) return data;
    if (/^[ \n\r\t]*$/.test(data)) return ''; // reine Formatierung im HTML-Quelltext
    return data.replace(/[\n\r\t]/g, ' ');
  }

  function preservesWhitespace(element) {
    if (!element) return false;
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    if (style.whiteSpaceCollapse) return style.whiteSpaceCollapse !== 'collapse';
    return style.whiteSpace.startsWith('pre') || style.whiteSpace === 'break-spaces';
  }

  /** <br> ohne nachfolgenden Inhalt in derselben Zeile erzeugt keine neue Zeile. */
  function isTrailingBr(br, root) {
    for (let node = br; ; node = node.parentNode) {
      for (let next = node.nextSibling; next; next = next.nextSibling) {
        if (next.nodeType === TEXT_NODE) {
          if (/^[ \n\r\t]*$/.test(next.data)) continue;
          return false;
        }
        if (next.nodeType !== ELEMENT_NODE || INVISIBLE_TAGS.has(next.localName)) continue;
        return BLOCK_TAGS.has(next.localName);
      }
      const parent = node.parentNode;
      if (!parent || parent === root || BLOCK_TAGS.has(parent.localName)) return true;
    }
  }

  function segmentAt(model, offset) {
    const { segments } = model;
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (segments[mid].start <= offset) low = mid;
      else high = mid - 1;
    }
    return segments[low];
  }

  const positionBefore = (model, offset) => {
    const segment = segmentAt(model, offset);
    return segment.kind === 'text' ? [segment.node, offset - segment.start] : segment.before;
  };

  const positionAfter = (model, offset) => {
    const segment = segmentAt(model, offset);
    return segment.kind === 'text' ? [segment.node, offset - segment.start + 1] : segment.after;
  };

  /**
   * Übersetzt String-Edits in DOM-Operationen. Pro Edit und Segmentart entsteht eine Operation:
   *  - Text: Range exakt über den betroffenen Zeichen eines Textknotens. Bewusst nicht mit
   *    Nachbar-Edits über unveränderten Text hinweg zusammengefasst: Beginnt eine Range mit
   *    kollabiertem Leerraum, schiebt Chrome ihren Anfang dahinter und das Zeichen bliebe stehen.
   *  - Umbrüche: Range von „hinter der Zeile davor“ bis „vor dem nächsten behaltenen Zeichen“.
   * Edits, die unveränderlichen Inhalt berühren oder Umbrüche *einfügen* würden, entfallen.
   */
  function toOperations(model, edits) {
    const operations = [];
    for (const edit of edits) {
      const pieces = [];
      for (let offset = edit.start; offset < edit.end; ) {
        const segment = segmentAt(model, offset);
        const end = Math.min(segment.end, edit.end);
        pieces.push({ segment, start: offset, end });
        offset = end;
      }
      const hasBreak = pieces.some((p) => p.segment.kind === 'break');
      if (pieces.length === 0 || pieces.some((p) => p.segment.kind === 'opaque')) continue;
      if (hasBreak && (edit.text !== '' || pieces.some((p) => p.segment.kind === 'break' && !p.segment.mergeable))) continue;

      let replacement = edit.text; // geht an das erste Textstück, weitere Stücke werden gelöscht
      for (const piece of pieces) {
        const last = operations[operations.length - 1];
        if (piece.segment.kind === 'break') {
          if (last?.kind === 'break' && last.end === piece.start) last.end = piece.end;
          else operations.push({ kind: 'break', start: piece.start, end: piece.end });
          continue;
        }
        const from = piece.start - piece.segment.start;
        const to = piece.end - piece.segment.start;
        operations.push({ kind: 'text', node: piece.segment.node, from, to, text: replacement });
        replacement = '';
      }
    }
    return operations;
  }

  function operationRange(doc, model, operation) {
    const range = doc.createRange();
    if (operation.kind === 'text') {
      range.setStart(operation.node, operation.from);
      range.setEnd(operation.node, operation.to);
    } else {
      // Beginn möglichst direkt hinter dem letzten Textzeichen der Zeile davor (eindeutige Position).
      const previous = operation.start > 0 ? segmentAt(model, operation.start - 1) : null;
      if (previous && previous.kind !== 'break') range.setStart(...positionAfter(model, operation.start - 1));
      else range.setStart(...positionBefore(model, operation.start));
      if (operation.end < model.text.length) range.setEnd(...positionBefore(model, operation.end));
      else range.setEnd(...positionAfter(model, operation.end - 1));
    }
    return range;
  }

  function lintContentEditable(host) {
    const doc = host.ownerDocument;
    const selection = doc.getSelection();
    const model = buildModel(host);
    const { text: expected, count } = lint(model.text);
    if (expected === model.text) return { status: 'ok', count: 0 };

    const edits = computeEdits(model.text, expected);
    const operations = toOperations(model, edits);
    const caret = caretOffset(model, selection);
    const restoreScroll = saveScroll(host);

    // Ranges vorab berechnen, dann von hinten nach vorn anwenden: So bleiben die DOM-Positionen
    // weiter vorn gültig, egal was der Browser beim Zusammenführen von Zeilen umbaut.
    let applied = 0;
    const ranges = operations.map((operation) => {
      try {
        return { operation, range: operationRange(doc, model, operation) };
      } catch {
        return null; // Knoten schon weg oder Offset ungültig: diese Stelle auslassen
      }
    });
    for (const entry of ranges.reverse()) {
      if (!entry) continue;
      selection.removeAllRanges();
      selection.addRange(entry.range);
      // insertText('') statt 'delete': Bei kollabiertem Leerraum ist das ein No-op, 'delete'
      // würde dagegen wie Backspace das Zeichen davor löschen.
      if (doc.execCommand('insertText', false, entry.operation.text)) applied++;
    }

    // Sicherheitsnetz: Außer Leerraum darf sich nur geändert haben, was die Regeln vorsehen.
    const result = buildModel(host);
    if (skeleton(result.text) !== skeleton(expected)) {
      for (let i = 0; i < applied; i++) doc.execCommand('undo');
      restoreScroll();
      return { status: 'error' };
    }

    groupUndoSteps(host, applied);
    if (caret !== null) restoreCaret(result, selection, mapOffset(edits, caret));
    restoreScroll();
    const remaining = lint(result.text).count;
    return { status: 'ok', count: Math.max(0, count - remaining), skipped: remaining };
  }

  const skeleton = (text) => text.replace(/\s/g, '');

  function caretOffset(model, selection) {
    if (!selection || selection.rangeCount === 0) return null;
    const segment = model.segments.find((s) => s.kind === 'text' && s.node === selection.focusNode);
    return segment ? segment.start + Math.min(selection.focusOffset, segment.end - segment.start) : null;
  }

  function restoreCaret(model, selection, offset) {
    const segment = model.segments.find((s) => s.kind === 'text' && s.start <= offset && offset <= s.end);
    if (!segment) return;
    selection.collapse(segment.node, offset - segment.start);
  }

  function saveScroll(element) {
    const saved = [];
    for (let node = element; node; node = node.parentElement) {
      if (node.scrollTop || node.scrollLeft) saved.push([node, node.scrollTop, node.scrollLeft]);
    }
    const win = element.ownerDocument.defaultView;
    const { scrollX, scrollY } = win;
    return () => {
      for (const [node, top, left] of saved) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
      win.scrollTo(scrollX, scrollY);
    };
  }

  /**
   * In contenteditable legt jedes execCommand einen eigenen Undo-Schritt an. Damit ein einziges
   * Strg+Z die ganze Korrektur zurücknimmt, ergänzen wir das nächste native Undo um die übrigen
   * Schritte (Redo analog). Der Listener liest nur `inputType`, nie Tasten oder Text, und entfernt
   * sich bei der ersten anderen Eingabe selbst. Editoren mit eigenem Undo (preventDefault) bleiben
   * unberührt.
   */
  function groupUndoSteps(host, steps) {
    if (steps < 2) return;
    const doc = host.ownerDocument;
    let expected = 'historyUndo';
    let replaying = false;
    const stop = () => host.removeEventListener('beforeinput', onBeforeInput, true);
    function onBeforeInput(event) {
      if (replaying) return;
      if (event.inputType !== expected) return stop();
      const command = expected === 'historyUndo' ? 'undo' : 'redo';
      expected = expected === 'historyUndo' ? 'historyRedo' : 'historyUndo';
      setTimeout(() => {
        if (event.defaultPrevented) return stop();
        replaying = true;
        try {
          for (let i = 1; i < steps; i++) doc.execCommand(command);
        } finally {
          replaying = false;
        }
      }, 0);
    }
    host.addEventListener('beforeinput', onBeforeInput, true);
  }

  // --- textarea / input ------------------------------------------------------------------------

  function lintTextControl(el) {
    const original = el.value;
    const { text: expected, count } = lint(original);
    if (expected === original) return { status: 'ok', count: 0 };

    const edits = computeEdits(original, expected);
    const caret = el.selectionStart === null ? null : [el.selectionStart, el.selectionEnd];
    const { scrollTop, scrollLeft } = el;

    // Nur den geänderten Bereich ersetzen: ein Undo-Schritt, Cursor und Scrollposition bleiben ruhig.
    let start = edits[0].start;
    let end = edits[edits.length - 1].end;
    let replacement = expected.slice(start, end + expected.length - original.length);
    try {
      el.setSelectionRange(start, end);
    } catch {
      // type=email kennt keine Selection-API: ganzen Inhalt ersetzen.
      el.select();
      [start, end, replacement] = [0, original.length, expected];
    }
    const inserted = el.ownerDocument.execCommand('insertText', false, replacement);
    if (!inserted || el.value === original) {
      // Fallback ohne Undo: nativer Setter (umgeht die value-Wrapper von React & Co.) + input-Event.
      const proto = el.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, expected);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
    }
    if (caret) el.setSelectionRange(mapOffset(edits, caret[0]), mapOffset(edits, caret[1]));
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
    return { status: 'ok', count };
  }

  // --- Feld finden -----------------------------------------------------------------------------

  /** Fokussiertes Element, auch in Shadow DOM und gleich-originigen iframes. */
  function deepActiveElement(doc) {
    let el = doc.activeElement;
    while (el) {
      const shadow = el.shadowRoot ?? globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el);
      if (shadow?.activeElement) {
        el = shadow.activeElement;
        continue;
      }
      // contentDocument ist bei Cross-Origin-iframes null. Dort hilft activeTab ohnehin nicht.
      const inner = el.localName === 'iframe' || el.localName === 'frame' ? el.contentDocument : null;
      if (inner?.activeElement) {
        el = inner.activeElement;
        continue;
      }
      return el;
    }
    return null;
  }

  function findField(doc) {
    const el = deepActiveElement(doc);
    if (!el) return { kind: 'none' };
    if (el.localName === 'textarea' || el.localName === 'input') {
      // Passwort-, Zahlen-, Datumsfelder usw. werden bewusst nie angefasst.
      if (el.localName === 'input' && !TEXT_INPUT_TYPES.has(el.type)) return { kind: 'unsupported', el };
      return { kind: el.readOnly || el.disabled ? 'readonly' : 'text-control', el };
    }
    if (el.isContentEditable) {
      let host = el;
      while (host.parentElement?.isContentEditable) host = host.parentElement;
      return { kind: 'contenteditable', el: host };
    }
    return { kind: 'none' };
  }

  // --- Feedback --------------------------------------------------------------------------------

  function message(result) {
    switch (result.status) {
      case 'ok': {
        if (result.count === 0 && !result.skipped) return 'Keine Korrekturen nötig';
        const done = `✓ ${result.count} ${result.count === 1 ? 'Korrektur' : 'Korrekturen'}`;
        return result.skipped ? `${done} · ${result.skipped} nicht änderbar` : done;
      }
      case 'readonly': return 'Feld ist schreibgeschützt';
      case 'unsupported': return 'Dieses Feld wird nicht unterstützt';
      case 'error': return 'Abgebrochen – nichts geändert';
      case 'failed': return 'Fehler beim Bereinigen';
      default: return 'Kein Textfeld fokussiert';
    }
  }

  /** Rechteck eines Elements relativ zum Viewport des obersten Dokuments (über iframes hinweg). */
  function viewportRect(el) {
    let { top, right } = el.getBoundingClientRect();
    for (let win = el.ownerDocument.defaultView; win?.frameElement; win = win.parent) {
      const frame = win.frameElement.getBoundingClientRect();
      top += frame.top;
      right += frame.left;
    }
    return { top, right };
  }

  /** Kurzer Hinweis am Feld. Closed Shadow DOM schützt vor Seiten-CSS, Text nur via textContent. */
  function showToast(text, anchor) {
    globalThis.BrowserLinterToast?.remove();
    const host = document.createElement('browser-linter-toast');
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.textContent = text;
    box.style.cssText = [
      'font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      'color: #fff', 'background: #1f2328', 'padding: 6px 12px', 'border-radius: 8px',
      'box-shadow: 0 4px 16px rgba(0,0,0,.25)', 'white-space: nowrap',
    ].join(';');
    host.attachShadow({ mode: 'closed' }).append(box);

    const viewWidth = document.documentElement.clientWidth || innerWidth;
    const rect = anchor ? viewportRect(anchor) : { top: 56, right: viewWidth - 16 };
    const top = Math.min(Math.max(rect.top - 40, 8), innerHeight - 48);
    const right = Math.min(Math.max(viewWidth - rect.right, 8), viewWidth - 160);
    for (const [property, value] of [
      ['position', 'fixed'], ['top', `${top}px`], ['right', `${right}px`],
      ['z-index', '2147483647'], ['pointer-events', 'none'], ['margin', '0'],
    ]) host.style.setProperty(property, value, 'important');

    // An <html> statt <body> hängen: <body> kann selbst editierbar sein (designMode).
    document.documentElement.append(host);
    globalThis.BrowserLinterToast = host;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still) box.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], 150);
    setTimeout(() => {
      const fade = still ? null : box.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
      const remove = () => host.remove();
      if (fade) fade.onfinish = remove;
      else remove();
    }, 1600);
  }

  // --- Einstiegspunkt --------------------------------------------------------------------------

  /** @returns {{ status: string, count?: number, skipped?: number }} */
  function lintFocusedField() {
    const field = findField(document);
    let result;
    try {
      if (field.kind === 'text-control') result = lintTextControl(field.el);
      else if (field.kind === 'contenteditable') result = lintContentEditable(field.el);
      else result = { status: field.kind === 'none' ? 'no-field' : field.kind };
    } catch (error) {
      console.error('[Browser Lint]', error);
      result = { status: 'failed' };
    }
    showToast(message(result), field.el);
    return result;
  }

  globalThis.BrowserLinter = Object.assign(globalThis.BrowserLinter ?? {}, { lintFocusedField, buildModel });
})();
