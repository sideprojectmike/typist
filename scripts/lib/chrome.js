// Minimal Chrome launcher + raw CDP client for probes and end-to-end tests.
// Uses Node's built-in fetch and WebSocket, no Puppeteer.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.TYPIST_CHROME
  ?? '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ port = 9333, extension, headless = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'typist-chrome-'));
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--window-position=40,40', '--window-size=1100,800',
    ...(headless ? ['--headless=new'] : []),
    ...(extension ? [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] : []),
    'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  const base = `http://localhost:${port}`; // Chrome binds the DevTools port on IPv6 localhost
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/json/version`); break; } catch {
      if (i === 100) { proc.kill(); throw new Error(`Chrome did not open DevTools on ${base}`); }
      await sleep(100);
    }
  }
  return {
    base,
    async targets() { return (await fetch(`${base}/json/list`)).json(); },
    async page(url = 'about:blank') {
      const t = await (await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
      const page = await connect(t.webSocketDebuggerUrl);
      await page.waitFor(`document.readyState === 'complete' && location.href !== 'about:blank' || ${JSON.stringify(url)} === 'about:blank'`);
      page.targetId = t.id;
      return page;
    },
    async activate(targetId) { await fetch(`${base}/json/activate/${targetId}`); },
    async close() {
      proc.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(`${msg.error.message}`)) : p.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeout = 10000) {
      for (const start = Date.now(); Date.now() - start < timeout; await sleep(50)) {
        try { if (await this.eval(expression)) return; } catch {}
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    close: () => ws.close(),
  };
}
