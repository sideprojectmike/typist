// Service worker: keeps a WebSocket to the local Typist MCP server and
// routes its requests to the job manager.
//
// Protocol (JSON): server -> { id, method, params }
//                  extension -> { id, result } | { id, error: { message } } | { id, progress }
import { listFields } from './fields.js';
import { cancelJob, runJob } from './jobs.js';

export const DEFAULT_PORT = 17373;
const RETRY_MS = 3000;
const PING_MS = 20000; // WebSocket traffic keeps an MV3 service worker alive
const IDLE_MS = 5 * 60 * 1000; // fall asleep after this long without a request

// Sleep mode: Typist starts asleep (and falls asleep after IDLE_MS without a
// request). While asleep it holds no connection and makes no attempts, so
// nothing on this machine can talk to it. Clicking the toolbar icon wakes it.
// State lives in storage.session, so it survives worker restarts and is
// cleared (asleep) whenever Chrome restarts.
let socket = null;
let retryTimer = null;
let busy = 0; // requests in flight; never sleep in the middle of a job

const isAwake = async () => (await chrome.storage.session.get('awake')).awake === true;
const touch = () => chrome.storage.session.set({ lastActivity: Date.now() });

async function wake() {
  await chrome.storage.session.set({ awake: true, lastActivity: Date.now() });
  await chrome.action.setBadgeText({ text: '' });
  connect();
}

async function sleep() {
  await chrome.storage.session.set({ awake: false });
  clearTimeout(retryTimer);
  const ws = socket;
  socket = null;
  ws?.close();
  cancelJob();
  await chrome.action.setBadgeText({ text: 'zz' });
  setStatus('asleep', 'Idle for 5 minutes. Click the Typist toolbar icon to wake it.');
}

async function tick() {
  if (!(await isAwake())) return;
  const { lastActivity = 0 } = await chrome.storage.session.get('lastActivity');
  if (!busy && Date.now() - lastActivity > IDLE_MS) return sleep();
  connect();
}

const hmac = async (token, msg) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
};

const setStatus = (status, detail = '') => chrome.storage.session.set({ connection: { status, detail, at: Date.now() } });

async function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  clearTimeout(retryTimer);
  if (!(await isAwake())) {
    await chrome.action.setBadgeText({ text: 'zz' });
    return setStatus('asleep', 'Click the Typist toolbar icon to wake it.');
  }
  const { port = DEFAULT_PORT, token = '' } = await chrome.storage.local.get(['port', 'token']);
  if (!token) return setStatus('not configured', 'Paste the token printed by the MCP server into Typist settings.');

  // Never send the token; prove we know it, and only obey a server that
  // proves it knows it too (see mcp-server/bridge.js).
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const [clientProof, serverProof] = await Promise.all([hmac(token, `client:${nonce}`), hmac(token, `server:${nonce}`)]);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?nonce=${nonce}&proof=${clientProof}`);
  socket = ws;
  let verified = false;
  let rejected = false;
  let ping;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (verified) return handle(ws, msg);
    if (msg.type !== 'auth' || msg.proof !== serverProof) {
      rejected = true;
      setStatus('disconnected', `Something on port ${port} isn't a Typist server with this token; ignoring it.`);
      return ws.close();
    }
    verified = true;
    touch();
    setStatus('connected', `ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
    ping = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), PING_MS);
  };
  ws.onerror = () => {};
  ws.onclose = (e) => {
    clearInterval(ping);
    if (socket === ws) socket = null;
    cancelJob(); // nobody is left to receive the result
    if (socket !== null && socket !== ws) return; // replaced, or put to sleep
    isAwake().then((awake) => {
      if (!awake) return;
      if (!rejected) setStatus('disconnected', e.code === 1008 ? e.reason : 'Waiting for the Typist MCP server (Claude starts it).');
      retryTimer = setTimeout(connect, RETRY_MS);
    });
  };
}

async function handle(ws, msg) {
  if (msg.id === undefined) return;
  const reply = (body) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: msg.id, ...body }));
  busy++;
  touch();
  try {
    if (msg.method === 'list_fields') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error('no active tab');
      reply({ result: { url: tab.url, title: tab.title, fields: await listFields(tab.id) } });
    } else if (msg.method === 'type_text') {
      reply({ result: await runJob(msg.params, (progress) => reply({ progress })) });
    } else if (msg.method === 'cancel') {
      reply({ result: cancelJob() });
    } else {
      throw new Error(`unknown method ${msg.method}`);
    }
  } catch (e) {
    reply({ error: { message: e.message } });
  } finally {
    busy--;
    touch(); // the idle timer starts when the last job ends
  }
}

// MV3 workers sleep when idle; the alarm wakes this one to reconnect.
chrome.alarms.create('typist-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(tick);
chrome.runtime.onStartup.addListener(tick);
chrome.runtime.onInstalled.addListener(tick);
chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.port || changes.token)) {
    socket?.close();
    socket = null;
    connect();
  }
});
// The icon wakes Typist and opens settings so you can see it connect.
chrome.action.onClicked.addListener(() => { wake(); chrome.runtime.openOptionsPage(); });
tick();
