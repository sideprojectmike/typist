// WebSocket bridge to the Typist Chrome extension.
//
// The first server to start owns 127.0.0.1:<port>; the extension connects to
// it. Any later server (another Claude chat or app) finds the port taken and
// becomes a relay: it connects to the owner with the same token and forwards
// its requests through it. If the owner exits, a relay takes over the port.
//
// The token is never sent. A client connects with ?nonce=N&proof=HMAC(token,
// "client:N") and the server answers { type: 'auth', proof: HMAC(token,
// "server:N") }. Clients ignore everything until that proof checks out, so a
// program squatting on the port can neither learn the token nor send commands.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const proof = (token, side, nonce) => createHmac('sha256', token).update(`${side}:${nonce}`).digest('hex');

export class Bridge {
  constructor({ port, token, extensionId, log = () => {} }) {
    Object.assign(this, { port, token, extensionId, log });
    this.link = null; // socket requests go out on: the extension (owner) or the owner (relay)
    this.pending = new Map();
    this.waiters = [];
    this.seq = 0;
    this.startError = null;
    this.seenNonces = new Set(); // a captured client proof can't be replayed
  }

  start() {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      wss.on('listening', () => {
        this.wss = wss;
        this.log(`listening on ws://127.0.0.1:${this.port}`);
        resolve();
      });
      wss.on('error', (e) => {
        if (e.code === 'EADDRINUSE') this.relay();
        else { this.startError = e; this.log(e.message); }
        resolve();
      });
      wss.on('connection', (ws, req) => this.accept(ws, req));
    });
  }

  relay() {
    const nonce = randomBytes(16).toString('hex');
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/?role=relay&nonce=${nonce}&proof=${proof(this.token, 'client', nonce)}`);
    let verified = false;
    ws.on('message', (data) => {
      if (verified) return this.onReply(data);
      let msg;
      try { msg = JSON.parse(data); } catch { msg = {}; }
      if (msg.type !== 'auth' || !safeEqual(String(msg.proof ?? ''), proof(this.token, 'server', nonce))) {
        this.log(`whatever is on port ${this.port} is not a Typist server with this token; not relaying`);
        return ws.close();
      }
      verified = true;
      this.log(`port ${this.port} is in use; relaying through the Typist server there`);
      this.setLink(ws);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      this.dropLink(ws, 'the Typist server this one relays through has stopped');
      setTimeout(() => !this.closed && this.start(), 300 + Math.random() * 700); // take over the port, or relay again
    });
  }

  accept(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const nonce = url.searchParams.get('nonce') ?? '';
    const authed = /^[0-9a-f]{32}$/.test(nonce) && !this.seenNonces.has(nonce)
      && safeEqual(url.searchParams.get('proof') ?? '', proof(this.token, 'client', nonce));
    const origin = req.headers.origin ?? '';
    const prove = () => { this.seenNonces.add(nonce); ws.send(JSON.stringify({ type: 'auth', proof: proof(this.token, 'server', nonce) })); };
    if (url.searchParams.get('role') === 'relay') {
      if (!authed) return ws.close(1008, 'wrong token');
      prove();
      return this.serveRelay(ws);
    }
    const originOk = this.extensionId ? origin === `chrome-extension://${this.extensionId}` : origin.startsWith('chrome-extension://');
    if (!originOk) return ws.close(1008, 'origin not allowed');
    if (!authed) return ws.close(1008, 'Wrong token. Run `npm run token` in the typist folder and paste it into Typist settings.');
    prove();

    if (this.link) this.link.close(1000, 'replaced by a newer connection');
    this.log(`extension connected (${origin})`);
    this.setLink(ws);
    ws.on('message', (data) => this.onReply(data));
    ws.on('close', () => this.dropLink(ws, 'the Chrome extension disconnected before replying'));
  }

  // Forward a relay's requests to the extension and stream the replies back.
  serveRelay(ws) {
    const send = (body) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(body));
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try {
        const result = await this.request(msg.method, msg.params, { onProgress: (progress) => send({ id: msg.id, progress }) });
        send({ id: msg.id, result });
      } catch (e) {
        send({ id: msg.id, error: { message: e.message } });
      }
    });
  }

  setLink(ws) {
    this.link = ws;
    this.waiters.splice(0).forEach((w) => w(ws));
  }

  dropLink(ws, reason) {
    if (this.link !== ws) return;
    this.link = null;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }

  onReply(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.progress) return p.onProgress?.(msg.progress);
    this.pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }

  // The extension reconnects within ~30s of the server starting (its worker
  // wakes on a 30s alarm), so the first request may need to wait.
  connection(timeoutMs = 35000) {
    if (this.link) return Promise.resolve(this.link);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error(`the Typist Chrome extension is not connected. Check that it is installed and enabled, and that its settings have port ${this.port} and the token from \`npm run token\`.`));
      }, timeoutMs);
      const done = (ws) => { clearTimeout(timer); resolve(ws); };
      this.waiters.push(done);
    });
  }

  async request(method, params = {}, { onProgress, signal } = {}) {
    if (this.startError) throw this.startError;
    const ws = await this.connection();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      ws.send(JSON.stringify({ id, method, params }));
      signal?.addEventListener('abort', () => {
        if (this.pending.has(id)) this.request('cancel').catch(() => {});
      }, { once: true });
    });
  }

  close() {
    this.closed = true;
    this.wss?.close();
    if (this.link?.readyState <= WebSocket.OPEN) this.link.close();
  }
}
