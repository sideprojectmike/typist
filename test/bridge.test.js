import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { Bridge, proof } from '../mcp-server/bridge.js';

const TOKEN = 't0ken';
const PORT = 17399;
const nonce = () => crypto.randomUUID().replace(/-/g, '');
const connect = (n, p) => new WebSocket(`ws://127.0.0.1:${PORT}/?nonce=${n}&proof=${p}`, { origin: 'chrome-extension://abc' });

test('server proves itself and rejects bad or replayed client proofs', async () => {
  const bridge = new Bridge({ port: PORT, token: TOKEN });
  await bridge.start();
  try {
    const n = nonce();
    const ok = connect(n, proof(TOKEN, 'client', n));
    const [data] = await once(ok, 'message');
    assert.deepEqual(JSON.parse(data), { type: 'auth', proof: proof(TOKEN, 'server', n) });
    ok.close();

    const [bad] = await once(connect(n, proof('wrong', 'client', n)), 'close');
    assert.equal(bad, 1008);
    const [replay] = await once(connect(n, proof(TOKEN, 'client', n)), 'close');
    assert.equal(replay, 1008);
  } finally {
    bridge.close();
  }
});

test('extension HMAC (WebCrypto) matches the server\'s', async () => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('server:abc'))).toString('hex');
  assert.equal(sig, proof(TOKEN, 'server', 'abc'));
});

test('a relay never trusts an impostor on the port and never sends it the token', async () => {
  const impostor = new WebSocketServer({ host: '127.0.0.1', port: PORT + 1 });
  await once(impostor, 'listening');
  const bridge = new Bridge({ port: PORT + 1, token: TOKEN });
  const [[ws, req]] = await Promise.all([once(impostor, 'connection'), bridge.start()]);
  assert.ok(!req.url.includes(TOKEN));
  ws.send(JSON.stringify({ type: 'auth', proof: 'nope' }));
  await once(ws, 'close');
  assert.equal(bridge.link, null);
  bridge.close();
  impostor.close();
});
