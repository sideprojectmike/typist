import { DEFAULTS, validateSettings } from './engine/settings.js';

const DEFAULT_PORT = 17373; // keep in sync with sw.js
const $ = (id) => document.getElementById(id);
const num = (id) => (($(id).value === '') ? NaN : Number($(id).value));

function show(s) {
  $('wpm').value = $('wpm-range').value = s.wpm;
  $('variation').value = $('variation-range').value = s.variation;
  $('mistakes_enabled').checked = s.mistakes_enabled;
  $('mistake_rate').value = +(s.mistake_rate * 100).toFixed(2);
  $('detection_min').value = s.detection_delay.min;
  $('detection_max').value = s.detection_delay.max;
  $('pause_min').value = s.correction_pause.min;
  $('pause_max').value = s.correction_pause.max;
  $('mode').value = s.mode;
  $('newline').value = s.newline;
  syncEnabled();
}

const read = () => ({
  wpm: num('wpm'),
  variation: num('variation'),
  mistakes_enabled: $('mistakes_enabled').checked,
  mistake_rate: num('mistake_rate') / 100,
  detection_delay: { min: num('detection_min'), max: num('detection_max') },
  correction_pause: { min: num('pause_min'), max: num('pause_max') },
  mode: $('mode').value,
  newline: $('newline').value,
});

function syncEnabled() {
  for (const id of ['mistake_rate', 'detection_min', 'detection_max', 'pause_min', 'pause_max']) {
    $(id).disabled = !$('mistakes_enabled').checked;
  }
}

function say(el, text, kind) {
  el.textContent = text;
  el.className = kind;
}

for (const name of ['wpm', 'variation']) {
  $(`${name}-range`).addEventListener('input', () => { $(name).value = $(`${name}-range`).value; });
  $(name).addEventListener('input', () => { $(`${name}-range`).value = $(name).value; });
}
$('mistakes_enabled').addEventListener('change', syncEnabled);

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const settings = validateSettings(read());
    await chrome.storage.sync.set({ settings });
    say($('message'), 'Saved', 'ok');
  } catch (err) {
    say($('message'), err.message.replace('mistake_rate" must be a number from 0 to 0.2', 'mistake rate" must be 0–20%'), 'error');
  }
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  show(DEFAULTS);
  say($('message'), 'Defaults restored', 'ok');
});

$('connection').addEventListener('submit', async (e) => {
  e.preventDefault();
  const port = num('port');
  const token = $('token').value.trim();
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return say($('conn-message'), 'Port must be 1024–65535', 'error');
  if (!token) return say($('conn-message'), 'Token is required', 'error');
  await chrome.storage.local.set({ port, token });
  say($('conn-message'), 'Saved', 'ok');
});

function showStatus(connection) {
  const { status = 'starting', detail = '' } = connection ?? {};
  $('status').textContent = detail ? `${status} — ${detail}` : status;
  $('status-dot').className = status === 'connected' ? 'connected' : status === 'disconnected' ? 'disconnected' : '';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.connection) showStatus(changes.connection.newValue);
});

const { settings } = await chrome.storage.sync.get('settings');
show({ ...DEFAULTS, ...settings });
const { port = DEFAULT_PORT, token = '' } = await chrome.storage.local.get(['port', 'token']);
$('port').value = port;
$('token').value = token;
showStatus((await chrome.storage.session.get('connection')).connection);
