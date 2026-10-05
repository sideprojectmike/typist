// End-to-end test: MCP client -> Typist MCP server -> WebSocket -> extension
// -> chrome.debugger -> real page. Every check reads the page independently
// of the extension's own verification.
//   node scripts/e2e.js [--headless]
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DEFAULTS } from '../extension/engine/settings.js';
import { launchChrome } from './lib/chrome.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTTP_PORT = 8765;
const WS_PORT = 17399;
const TOKEN = 'e2e-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static server for the fixture page ----------------------------------
const FILES = {
  '/index.html': 'test/e2e/fixtures/index.html',
  '/frame.html': 'test/e2e/fixtures/frame.html',
  '/vendor/quill.js': 'node_modules/quill/dist/quill.js',
  '/vendor/quill.snow.css': 'node_modules/quill/dist/quill.snow.css',
  '/vendor/react.js': 'node_modules/react/umd/react.production.min.js',
  '/vendor/react-dom.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
};
const http = createServer((req, res) => {
  const file = FILES[new URL(req.url, 'http://x').pathname];
  if (!file) return res.writeHead(404).end();
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(readFileSync(join(ROOT, file)));
});
await new Promise((r) => http.listen(HTTP_PORT, r));

// --- Chrome with the extension, and the MCP server via a real MCP client ---
const chrome = await launchChrome({ extension: join(ROOT, 'extension'), headless: process.argv.includes('--headless') });
let extensionId;
for (let i = 0; i < 100 && !extensionId; i++) {
  const sw = (await chrome.targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
  extensionId = sw && new URL(sw.url).host;
  if (!extensionId) await sleep(100);
}
if (!extensionId) throw new Error('extension did not load');

const client = new Client({ name: 'typist-e2e', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'mcp-server/index.js')],
  env: { ...process.env, TYPIST_PORT: String(WS_PORT), TYPIST_TOKEN: TOKEN, TYPIST_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'typist-cfg-')) },
  stderr: 'inherit',
}));

const options = await chrome.page(`chrome-extension://${extensionId}/options.html`);
await options.eval(`chrome.storage.local.set({ port: ${WS_PORT}, token: '${TOKEN}' })`);
const setSettings = (over) => options.eval(`chrome.storage.sync.set({ settings: ${JSON.stringify({ ...DEFAULTS, ...over })} })`);

const page = await chrome.page(`http://localhost:${HTTP_PORT}/index.html`);
await chrome.activate(page.targetId);
await page.waitFor(`document.querySelector('#react') && window.quill && document.querySelector('#cross').contentWindow`);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = r.content?.[0]?.text ?? '';
  try { return { ...JSON.parse(text), isError: r.isError }; } catch { return { raw: text, isError: r.isError }; }
}
const focus = (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
const value = (selector) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el.value ?? el.innerText.replace(/\\u00a0/g, ' '); })()`);

// --- tests -------------------------------------------------------------------
let failed = 0;
async function test(name, fn) {
  const start = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message.replace(/\n/g, '\n     ')}`);
  }
}
function expect(cond, msg, detail) {
  if (!cond) throw new Error(`${msg}${detail === undefined ? '' : `\n${JSON.stringify(detail, null, 2)}`}`);
}
const expectOk = (r, field, want) => {
  expect(r.ok === true && r.verified === true, 'expected ok + verified', r);
  if (want !== undefined) expect(field === want, `page has ${JSON.stringify(field)}, want ${JSON.stringify(want)}`);
};

let fields;
await test('list_fields connects and finds every kind of field', async () => {
  const r = await call('list_fields');
  fields = r.fields;
  expect(Array.isArray(fields), 'no fields', r);
  for (const label of ['Name', 'Notes', 'Plain editor', 'React', 'Inner', 'Cross-origin input']) {
    expect(fields.some((f) => f.label === label), `missing ${label}`, fields.map((f) => f.label));
  }
  expect(fields.find((f) => f.label === 'Inner').id.includes('@'), 'iframe field id should carry its frame');
});
const idOf = (label) => fields.find((f) => f.label === label).id;

await setSettings({ wpm: 150, mistake_rate: 0.03 });

await test('types into the focused field: "Hello, how are you?"', async () => {
  await focus('#notes');
  const r = await call('type_text', { text: 'Hello, how are you?' });
  expectOk(r, await value('#notes'), 'Hello, how are you?');
  expect(typeof r.seed === 'number' && r.effective_wpm > 0 && r.duration_ms > 0, 'missing stats', r);
});

await test('mistakes appear on screen while typing, final text exact', async () => {
  await setSettings({ wpm: 200, mistake_rate: 0.15 });
  const text = 'The quick brown fox jumps over the lazy dog.';
  const r = await call('type_text', { text, target: idOf('Name') });
  expectOk(r, await value('#name'), text);
  expect(r.mistakes > 0, 'expected some mistakes at 15%', r);
  const seen = await page.eval(`history_.name`);
  expect(seen.some((v) => !text.startsWith(v)), 'no wrong intermediate value was ever on screen', seen);
  // getTargets() counts this harness's own DevTools connection, so instead
  // try attaching from the extension: that only fails if it never detached.
  const attached = await options.eval(`(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://localhost/*' });
    try { await chrome.debugger.attach({ tabId: tab.id }, '1.3'); await chrome.debugger.detach({ tabId: tab.id }); return false; }
    catch (e) { return e.message; }
  })()`);
  expect(attached === false, 'extension debugger still attached after the job', attached);
});

await setSettings({ wpm: 200, mistake_rate: 0.05 });

await test('insert keeps existing text', async () => {
  const r = await call('type_text', { text: 'Ada Lovelace', target: '#prefilled' });
  expectOk(r, await value('#prefilled'), 'Name: Ada Lovelace');
});

await test('replace clears with keystrokes first', async () => {
  const r = await call('type_text', { text: 'Grace Hopper', target: '#prefilled', mode: 'replace' });
  expectOk(r, await value('#prefilled'), 'Grace Hopper');
});

await test('replace works on type=email (no caret API)', async () => {
  const r = await call('type_text', { text: 'new@example.com', target: '#email', mode: 'replace' });
  expectOk(r, await value('#email'), 'new@example.com');
});

await test('contenteditable: newlines, symbols, accents, CJK, emoji', async () => {
  const text = 'Line one: 100% {ok} <tag> ~`|\\\nLine two, café 中文 😀 👍🏽 done';
  const r = await call('type_text', { text, target: '#editor' });
  expectOk(r, await value('#editor'), text);
});

await test('contenteditable: Shift+Enter makes <br> line breaks', async () => {
  const r = await call('type_text', { text: 'one\ntwo', target: '#editor', mode: 'replace', newline: 'shift_enter' });
  expectOk(r, await value('#editor'), 'one\ntwo');
  expect((await page.eval(`document.querySelector('#editor').innerHTML`)).includes('<br>'), 'expected <br>');
});

await test('text ending in a newline (textarea and contenteditable)', async () => {
  let r = await call('type_text', { text: 'ends with a newline\n', target: '#notes', mode: 'replace' });
  expectOk(r, await value('#notes'), 'ends with a newline\n');
  r = await call('type_text', { text: 'para\n', target: '#editor', mode: 'replace' });
  expectOk(r);
  expect(r.final_text === 'para\n', 'final_text should keep the trailing newline', r);
});

await test('Quill rich-text editor', async () => {
  const text = 'Hello Quill.\nSecond paragraph, with "quotes".';
  const r = await call('type_text', { text, target: '#quill .ql-editor' });
  expectOk(r, await page.eval(`quill.getText()`), `${text}\n`);
});

await test('React controlled textarea stays in sync', async () => {
  const text = 'React state stays in sync.';
  const r = await call('type_text', { text, target: '#react' });
  expectOk(r, await page.eval(`document.querySelector('#react-state').textContent`), text);
});

await test('same-origin iframe, focused field', async () => {
  await page.eval(`document.querySelector('#same').contentDocument.querySelector('#inner').focus()`);
  const r = await call('type_text', { text: 'inside a frame' });
  expectOk(r, await page.eval(`document.querySelector('#same').contentDocument.querySelector('#inner').value`), 'inside a frame');
});

await test('cross-origin iframe by id', async () => {
  const r = await call('type_text', { text: 'cross origin', target: idOf('Cross-origin input') });
  const got = await page.eval(`new Promise((res) => { addEventListener('message', (e) => e.data.xvalue !== undefined && res(e.data.xvalue), { once: true }); document.querySelector('#cross').contentWindow.postMessage('value?', '*'); })`);
  expectOk(r, got, 'cross origin');
});

await test('one-off autocorrection is repaired', async () => {
  // Mistakes off: a typo on the first letter could otherwise absorb the
  // one-off capitalisation and leave nothing to repair.
  await setSettings({ wpm: 200, mistake_rate: 0 });
  const r = await call('type_text', { text: 'hello world', target: '#autocap' });
  expectOk(r, await value('#autocap'), 'hello world');
  expect(r.repairs >= 1, 'expected a repair', r);
});

await test('persistent rewriting fails honestly', async () => {
  await setSettings({ wpm: 200, mistake_rate: 0.05 });
  const r = await call('type_text', { text: "it's fine, isn't it", target: '#smartquote' });
  expect(r.ok === false && r.verified === false && r.isError, 'expected failure', r);
  expect(/repairs|already in the field/.test(r.error), 'error should explain', r);
});

await test('editor that hides its text is reported unverifiable', async () => {
  const r = await call('type_text', { text: 'nowhere to be seen', target: '#blackhole' });
  expect(r.ok === false && /can't be verified/.test(r.error), 'expected unverifiable failure', r);
  const swallowed = await page.eval('window.swallowed');
  // Stops at the first checkpoint. A mistake's trailing characters can run
  // into "to", but "be" is past any checkpoint, so it must never go out.
  expect(!swallowed.includes('be'), 'should stop at the first checkpoint, not keep typing', swallowed);
});

await test('newline into a single-line input is refused before typing', async () => {
  const r = await call('type_text', { text: 'a\nb', target: '#name', mode: 'replace' });
  expect(r.ok === false && /single-line/.test(r.error), 'expected refusal', r);
});

await test('Claude cannot set mistake_rate per request', async () => {
  const r = await client.callTool({ name: 'type_text', arguments: { text: 'x', mistake_rate: 0 } });
  expect(r.isError && /mistake_rate|Unrecognized/i.test(r.content[0].text), 'expected schema rejection', r);
});

await test('focus stolen mid-typing is restored; other field untouched', async () => {
  await setSettings({ wpm: 120, mistake_rate: 0.03 });
  const text = 'Focus can move while typing, and typing should resume in the right place.';
  const job = call('type_text', { text, target: '#notes2' });
  await sleep(1500);
  await focus('#other');
  const r = await job;
  expectOk(r, await value('#notes2'), text);
  expect(await value('#other') === '', 'keys leaked into #other');
});

await test('cancel stops a running job', async () => {
  await setSettings({ wpm: 60 });
  const job = call('type_text', { text: 'This sentence is long enough that it will still be typing when cancelled.', target: '#notes', mode: 'replace' });
  await sleep(2500);
  const c = await call('cancel');
  const r = await job;
  expect(c.cancelled === true, 'cancel did not find the job', c);
  expect(r.ok === false && r.error === 'cancelled', 'expected cancelled result', r);
});

await test('WPM sets the pace; result reports effective WPM', async () => {
  await setSettings({ wpm: 60, mistakes_enabled: false });
  const r = await call('type_text', { text: 'Speed check with mistakes disabled, typed at ninety words per minute.', target: '#notes', mode: 'replace', wpm: 90 });
  expectOk(r, await value('#notes'), 'Speed check with mistakes disabled, typed at ninety words per minute.');
  expect(r.effective_wpm > 65 && r.effective_wpm < 100, `effective_wpm ${r.effective_wpm} not near 90`, r);
  expect(r.mistakes === 0, 'mistakes were disabled', r);
});

console.log(failed ? `\n${failed} FAILED` : '\nall end-to-end tests passed');
await client.close();
await chrome.close();
http.close();
process.exit(failed ? 1 : 0);
