# Typist

Lets Claude type into Chrome one key at a time, like a person: natural rhythm,
occasional typos that get corrected, and a final check that the field holds
**exactly** the requested text. If that check can't pass, the result says
`ok: false`.

Claude decides **what** to type and where. The extension decides **how**.

```
Claude ──MCP──▶ mcp-server (Node) ──WebSocket 127.0.0.1──▶ Chrome extension ──CDP──▶ page
```

## Setup

You need Node 22+ (`brew install node`) and Chrome.

```sh
git clone https://github.com/sideprojectmike/typist.git ~/typist
cd ~/typist
npm install
npm run token            # prints the port and token, creating ~/.typist/config.json on first run
```

1. **Load the extension.** In `chrome://extensions`, turn on Developer mode, click
   **Load unpacked** and pick `~/typist/extension`.
2. **Connect it.** Click the Typist toolbar icon to open settings. Paste the token
   into **Connection** and click **Save and connect**.
3. **Register the MCP server with Claude Code:**
   ```sh
   claude mcp add typist --scope user -- node ~/typist/mcp-server/index.js
   ```
   For Claude Desktop, add this to `claude_desktop_config.json`:
   ```json
   { "mcpServers": { "typist": { "command": "node", "args": ["/Users/<you>/typist/mcp-server/index.js"] } } }
   ```

Claude starts the server when a session starts. The extension connects
within about 30 seconds and the settings page shows **connected**.

## Use

Click into a text box, then ask Claude something like:

> Type "Hello, how are you?" into the focused text box.

### Tools

| Tool | Arguments | |
|---|---|---|
| `list_fields` | — | Text fields on the active tab: id, kind, label, preview, focused |
| `type_text` | `text`, `target?`, `wpm?`, `mode?`, `newline?` | `target` is a `list_fields` id, a CSS selector, or omitted for the focused field |
| `cancel` | — | Stops the running job |

`type_text` accepts nothing else. A request that tries to set `mistake_rate`
or similar is rejected; those are extension settings.

```json
{ "ok": true, "verified": true, "final_text": "Hello, how are you?", "target": "f3",
  "mistakes": 1, "repairs": 0, "paused_ms": 0, "duration_ms": 4210, "effective_wpm": 54.2, "seed": 3516897361 }
```

```json
{ "ok": false, "verified": false, "error": "typed keys did not change the field's text. …", "final_text": "" }
```

`final_text` is the whole field as read back. `paused_ms` is the pause before typing (not included in `duration_ms`). `seed` reproduces the exact
plan: `createTypingPlan(text, settings, seed)`.

### Settings (extension options page)

| Setting | Default | |
|---|---|---|
| Words per minute | 60 | Pace of ordinary keystrokes. Claude can override per request |
| Variation | 0.35 | Spread of keystroke intervals (log-normal σ) |
| Mistakes on/off | on | |
| Mistake rate | 2% | Chance per character |
| Noticed after | 0–3 chars | How far typing runs past a mistake before it's noticed |
| Pause before correcting | 150–500 ms | |
| Mode | insert | `insert` at the caret, or `replace` the field's text |
| Newlines | Enter | Use Shift+Enter for chat boxes that send on Enter |
| Pause before typing | 0 s (off) | Wait before the first key of every `type_text` request, e.g. between questions on a form |
| Pause variation | 0 s | ± random spread on that pause, picked fresh each request (5 s ± 2 s → 3–7 s) |

WPM is the typing pace, not a deadline. Mistakes, corrections and the
occasional pause before a word add real time, so `effective_wpm` comes out a
little lower when mistakes are on.

## How correctness is guaranteed

1. Record the field's state: the text before and after the caret.
2. Build a plan of keys, backspaces and checkpoints, then replay it on a
   virtual buffer. A plan that wouldn't end on exactly the text is never run.
3. Type it through `chrome.debugger` (trusted key events), only while the target
   has focus. If focus moves away, Typist refocuses once things settle. It
   continues only if the field is exactly as typing left it.
4. After each word, read the field back. If something like autocorrect changed
   it, backspace to the first difference and retype, with mistakes off. This
   happens at most 3 times per job, and never touches text that was there before.
5. After a short settle, read the field one last time and compare it exactly.
   `ok: true` only if it matches.

If the field doesn't change at all when typed into (canvas editors), Typist
stops after the first word and reports that the result can't be verified.

## Behaviour and limits

- **Sleep mode.** Typist starts asleep whenever Chrome starts, and falls asleep
  after 5 minutes without a request (never during a job). While asleep it holds
  no connection and makes no attempts, and the toolbar icon shows **zz**. Click
  the icon to wake it; it connects within a few seconds.

- **Debugging bar.** Chrome shows "Typist started debugging this browser"
  while a job runs. Clicking its Cancel button stops the job with an error.
- **Keyboard.** Printable ASCII goes out as real key presses on a US QWERTY
  layout, with Shift for capitals and symbols. Other characters (é, 中文,
  emoji, tab) go in through `Input.insertText`, the path an IME uses: the
  text is inserted, but there's no keydown for it. Typos only ever happen on
  ASCII.
- **Newlines.** Not allowed in single-line inputs; that request is refused before
  typing.
- **Contenteditable** fields are always typed into at the end.
  Inputs and textareas keep the caret or selection if they were already focused.
- **`type=email`** fields don't expose a caret, so `insert` into one that
  already has text is refused; use `replace`.
- **Refused up front:** `chrome://` pages, the Web Store, and Google
  Slides/Sheets (canvas, can't be read back).
- **Google Docs** types at the document's own caret (click where you want it;
  `target` is ignored, `replace` is refused). Docs draws on a canvas, so Typist
  reads the doc back through its plain-text export and checks that it is the
  old text with exactly the requested text inserted in one piece. No per-word
  repairs, and the final check waits up to 15 s for Docs to save.
  Docs' automatic substitutions (smart quotes, `--` → —, auto-lists) make it
  `ok: false`; turn them off under Tools → Preferences if that matters.
  `final_text` is the whole document.
- **Who can make it type.** Only a Typist server that knows your token. The
  token is never sent over the connection: each side proves it knows it
  (HMAC challenge), so a web page or another program listening on the port
  can't learn it or send commands. While no Claude session is running, nothing
  can make Typist type. To turn it off completely, disable it in `chrome://extensions`.
- **One job at a time**, on the active tab of the focused window.
- **One server at a time.** A second Claude session's server can't bind the port, and its
  tools will say so.
- **Verified against:** input, textarea, plain contenteditable, Quill, a React
  controlled textarea, same-origin and cross-origin iframes. Not yet tested:
  Lexical, ProseMirror/Tiptap, Slate, CodeMirror and Monaco. Wherever text can't be read back, the result is
  `ok: false`, not a guess.

## Development

```sh
npm test         # engine unit tests (planner, mistakes, timing, settings, verify)
npm run probe    # checks keys.js against real Chrome via CDP
npm run e2e      # full stack: MCP client → server → extension → test page
```

`probe` and `e2e` need a Chrome that accepts `--load-extension`. Branded
Chrome doesn't any more, so use [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/)
and set `TYPIST_CHROME` to its binary. Add `--headless` to either one to run without a window.

```
extension/
  engine/       pure: settings, mistakes, planner, buffer (plan proof), timing, rng
  keys.js       character → CDP key events
  verify.js     pure: compare + repair planning
  page.js       runs in the page: find, focus, read fields
  fields.js     field ids across frames
  cdp.js        chrome.debugger session
  jobs.js       job manager: prepare → plan → type → checkpoints/repair → final verify
  sw.js         WebSocket connection to the MCP server
  options.*     settings page
mcp-server/     MCP tools + WebSocket bridge
scripts/        probe-cdp.js, e2e.js
```
