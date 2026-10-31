# Browser Lint

Chrome-Extension (Manifest V3), die wie der Obsidian Linter arbeitet, aber für beliebige Textfelder im Browser: Mails, Formulare, Kommentare. Tastenkürzel drücken, und der Text im **fokussierten Feld** wird nach festen Regeln bereinigt. Alles läuft lokal, nichts wird übertragen.

> Arbeitstitel. Der endgültige Name ist noch offen.

## Regeln

| Regel | Vorher | Nachher |
|---|---|---|
| Mehrfache Leerzeichen → eines (auch geschützte Leerzeichen/NBSP, wie Editoren sie speichern) | `Hallo␣␣Welt`, `Hallo&nbsp;␣Welt` | `Hallo␣Welt` |
| Leerzeichen vor `. , ; : ! ?` entfernen | `Hallo␣,␣wie␣geht's␣?` | `Hallo,␣wie␣geht's?` |
| Leerzeichen am Zeilenende entfernen | `Text␣␣⏎` | `Text⏎` |
| Mehrere Leerzeilen → genau eine | `a⏎⏎⏎⏎b` | `a⏎⏎b` |
| Drei Punkte → Auslassungszeichen | `Moment...` | `Moment…` |

Bewusst **unverändert** bleiben:

- Einrückungen am Zeilenanfang, Tabs, einzelne NBSP (`10 €`) und schmale Leerzeichen
- `.NET`, `.bashrc`, Smileys wie `:)` oder `;-)` (die Satzzeichen-Regel greift nur vor Leerraum oder Textende)
- `....` (nur genau drei Punkte werden ersetzt)
- der Signatur-Trenner `-- `
- Code: Markdown-Inline-Code `` `…` `` und Codeblöcke ```` ``` ```` / `~~~`; in Rich-Text-Editoren `<code>`, `<pre>`
- Zitate (`<blockquote>`, z. B. zitierte Mails in Gmail), Tabellen, nicht editierbare Elemente (Erwähnungs-Chips)
- Passwort-, Zahlen-, Datums- und andere Spezialfelder sowie schreibgeschützte Felder

## Installation (Entwicklermodus)

1. Repository klonen oder als ZIP herunterladen.
2. `chrome://extensions` öffnen, oben rechts den **Entwicklermodus** aktivieren.
3. **Entpackte Erweiterung laden** und den Projektordner (mit `manifest.json`) wählen.

## Benutzung

1. In ein Textfeld klicken.
2. **`Alt`+`Shift`+`L`** drücken, alternativ auf das Extension-Icon klicken.
3. Ein kurzer Hinweis am Feld zeigt das Ergebnis, z. B. „✓ 3 Korrekturen“ oder „Keine Korrekturen nötig“. Zusätzlich erscheint die Zahl kurz im Icon-Badge.
4. **`Strg`+`Z`** macht die gesamte Korrektur in einem Schritt rückgängig (auch in Gmail-artigen Editoren).

Unterstützt werden `textarea`, `input` vom Typ `text`, `search`, `email` und `url`, `contenteditable` (Gmail, Outlook Web und Co.), Shadow DOM sowie iframes mit gleichem Origin.

### Tastenkürzel ändern (z. B. Strg+S)

Unter `chrome://extensions/shortcuts` lässt sich das Kürzel frei belegen.

**Warum nicht Strg+S als Standard?** Getestet (siehe `tests/e2e/extension.e2e.test.js`): Chrome ignoriert `Ctrl+S` als vorgeschlagenes Kürzel, weil es Chromes eigener Befehl „Seite speichern“ ist. Das Kürzel bleibt dann leer. Manuell lässt es sich unter `chrome://extensions/shortcuts` eintragen. Dann fängt die Extension Strg+S aber auf **allen** Seiten ab, auch dort, wo es „Speichern“ bedeutet (Webmailer-Entwürfe, Online-IDEs, Google Docs).

## Berechtigungen und Datenschutz

| Berechtigung | Wofür |
|---|---|
| `activeTab` | Zugriff auf den aktuellen Tab, **nur** nach Tastenkürzel oder Icon-Klick und nur für diesen Tab |
| `scripting` | Den Linter-Code in diesem Moment in den Tab einspielen |

- **Keine** Host-Rechte, kein `<all_urls>`, keine dauerhaften Content Scripts. Deshalb gibt es bei der Installation keine Warnung „Kann alle Ihre Daten auf allen Websites lesen“.
- Kein Netzwerk, keine Telemetrie, kein Speicher, kein `eval`, kein `innerHTML`. Das wird durch `tests/security.test.js` abgesichert.
- Der Code läuft in der *isolierten Welt* der Extension. Die Webseite sieht ihn nicht und kann ihn nicht manipulieren.
- Text wird nur gelesen und geändert, wenn du das Kürzel drückst, und nur im fokussierten Feld.

## Bekannte Grenzen

- **Nicht nutzbar** auf `chrome://`-Seiten, im Chrome Web Store, im PDF-Viewer und in Google Docs (Canvas-Rendering). Das Badge zeigt dort „!“.
- **Cross-Origin-iframes** (Felder, die von einer anderen Domain eingebettet sind) sind nicht erreichbar, weil `activeTab` nur für den Origin des Tabs gilt.
- **Lokale Dateien** (`file://`) erst nach Aktivierung von „Zugriff auf Datei-URLs zulassen“ in den Extension-Details.
- **Editoren mit eigenem Modell** (ProseMirror, Lexical, Draft.js, Outlooks RoosterJS) erhalten echte `beforeinput`/`input`-Events und sollten funktionieren, sind aber nicht systematisch getestet. Bei Editoren mit eigenem Undo-Stack entscheidet deren Undo.
- In Rich-Text-Editoren werden leere Listenpunkte und Überschriften nicht als Leerzeilen entfernt. Der Hinweis zeigt dann z. B. „· 1 nicht änderbar“.
- Zwei Leerzeichen am Zeilenende (Markdown-Zeilenumbruch) werden entfernt.
- Linten mitten in einer IME-Eingabe (z. B. Japanisch) ist nicht vorgesehen.

## Entwicklung

Keine Abhängigkeiten, kein Build. Node ≥ 22 für die Tests.

```bash
npm test              # Unit-Tests: Regeln, Edit-Berechnung, Manifest/Sicherheit
npm run test:e2e      # Browser-Tests (braucht Playwright, siehe unten)
npm run test-page     # Testseite unter http://127.0.0.1:8080/
```

Die E2E-Tests nutzen [Playwright](https://playwright.dev/), das bewusst **nicht** als Abhängigkeit eingetragen ist. Fehlt es, werden die Tests übersprungen. Zum Ausführen: `npm i --no-save playwright && npx playwright install chromium`.

### Aufbau

```
manifest.json          Berechtigungen: activeTab + scripting, Kürzel Alt+Shift+L
src/background.js      Kürzel/Icon → executeScript in den aktiven Tab → Badge
src/rules.js           Regeln als reine Funktionen: lint(text) → { text, count }
src/edits.js           Diff „vorher → nachher“ als minimale Ersetzungen
src/inject.js          Feld finden, Edits per execCommand anwenden, Undo, Toast
tests/                 Unit-Tests (node:test) und E2E-Tests (tests/e2e/)
test-page/index.html   Lokale Testseite mit allen Feldtypen
icons/                 icon.svg (Quelle) und PNGs in 16/32/48/128 px
```

**Datenfluss:** Kürzel → Service Worker → `chrome.scripting.executeScript` lädt `rules.js`, `edits.js` und `inject.js` in die isolierte Welt des Tabs → `lintFocusedField()` → Ergebnis zurück → Badge.

**contenteditable:** `inject.js` bildet den sichtbaren Text als String ab (Textknoten, `<br>`/Blockgrenzen als `\n`, Code/Zitate als Platzhalter). Darauf laufen dieselben Regeln wie für Textfelder. Aus der Differenz entstehen minimale Edits, die per `execCommand('insertText')` genau an den betroffenen Stellen angewendet werden. So bleiben Formatierung und Undo-Stack erhalten, und Frameworks bekommen echte Input-Events. Nach dem Anwenden prüft ein Sicherheitsnetz, dass sich außer Leerraum nur die vorgesehenen Zeichen geändert haben. Andernfalls wird alles zurückgerollt.

**Neue Regel hinzufügen:** einen Eintrag `{ id, description, pattern, replacement }` in `RULES` (`src/rules.js`) anlegen und Tests in `tests/rules.test.js` ergänzen. Der Idempotenz-Fuzztest prüft automatisch, dass ein zweiter Lauf nichts mehr ändert.

## Roadmap

- **v0.2:** Optionsseite, Regeln einzeln ein-/ausschalten (`storage`-Berechtigung)
- **Store-Veröffentlichung:** Datenschutzerklärung („verarbeitet Text lokal, sammelt und überträgt nichts“), Single-Purpose-Beschreibung, Screenshots, Begründung der Berechtigungen
- Ideen: Anführungszeichen `"…"` → `„…“`, eigene Regeln
