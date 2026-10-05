// Checks extension/keys.js against real Chrome: sends each stroke through
// CDP and reads back what the field actually contains and which events fired.
//   node scripts/probe-cdp.js [--headless]
import { strokeFor } from '../extension/keys.js';
import { launchChrome } from './lib/chrome.js';

const PAGE = `data:text/html,${encodeURIComponent(`
<input id="i"><textarea id="t"></textarea>
<div id="c" contenteditable style="white-space:pre-wrap"></div>
<div id="d" contenteditable></div>
<script>
  window.log = [];
  for (const type of ['keydown', 'beforeinput']) document.addEventListener(type, (e) =>
    log.push({ type, key: e.key, code: e.code, shift: e.shiftKey, trusted: e.isTrusted, inputType: e.inputType, data: e.data }), true);
</script>`)}`;

const chrome = await launchChrome({ headless: process.argv.includes('--headless') });
const page = await chrome.page(PAGE);
await page.send('Runtime.enable');
await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });

async function type(id, ops, newline) {
  await page.eval(`(() => { const el = document.getElementById('${id}'); el.focus();
    if ('value' in el) el.value = ''; else el.innerHTML = ''; log = []; })()`);
  for (const op of ops) {
    const s = strokeFor(op, newline);
    if (s.insertText !== undefined) await page.send('Input.insertText', { text: s.insertText });
    else {
      for (const p of s.downs) await page.send('Input.dispatchKeyEvent', p);
      for (const p of s.ups) await page.send('Input.dispatchKeyEvent', p);
    }
  }
  return page.eval(`(() => { const el = document.getElementById('${id}');
    return { text: 'value' in el ? el.value : el.innerText.replace(/\\u00a0/g, ' '), html: el.innerHTML, log }; })()`);
}
const keys = (s) => Array.from(s).map((char) => ({ type: 'key', char }));
const BS = { type: 'backspace' };

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     want ${JSON.stringify(want)}\n     got  ${JSON.stringify(got)}`}`);
}

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
for (const id of ['i', 't', 'c']) {
  check(`[${id}] all printable ASCII`, (await type(id, keys(ASCII))).text, ASCII);
  check(`[${id}] backspace`, (await type(id, [...keys('abcX'), BS, ...keys('d')])).text, 'abcd');
  check(`[${id}] non-ASCII via insertText`, (await type(id, keys('café 中文 😀 👍🏽 a'))).text, 'café 中文 😀 👍🏽 a');
  check(`[${id}] backspace after emoji deletes it whole`, (await type(id, [...keys('a😀'), BS])).text, 'a');
  check(`[${id}] backspace after skin-tone emoji deletes it whole`, (await type(id, [...keys('a👍🏽'), BS])).text, 'a');
}
check('[d] plain contenteditable: spaces arrive as nbsp then normalise', (await type('d', keys('a  b c '))).text, 'a  b c ');

const r = await type('i', keys('A!'));
const kd = r.log.filter((e) => e.type === 'keydown');
check('keydown events are trusted', kd.every((e) => e.trusted), true);
check('Shift is pressed for uppercase and symbols', kd.map((e) => `${e.key}:${e.shift}`).join(' '), 'Shift:true A:true Shift:true !:true');
check('keydown carries code', kd.map((e) => e.code).join(' '), 'ShiftLeft KeyA ShiftLeft Digit1');

check('[t] Enter inserts newline', (await type('t', keys('a\nb'), 'enter')).text, 'a\nb');
check('[t] Shift+Enter inserts newline', (await type('t', keys('a\nb'), 'shift_enter')).text, 'a\nb');
check('[t] tab via insertText', (await type('t', keys('a\tb'))).text, 'a\tb');
check('[i] Enter does nothing in <input>', (await type('i', keys('a\nb'))).text, 'ab');
const enter = await type('c', keys('a\nb'), 'enter');
console.log(`     contenteditable Enter html: ${enter.html}  innerText: ${JSON.stringify(enter.text)}`);
const shiftEnter = await type('c', keys('a\nb'), 'shift_enter');
console.log(`     contenteditable Shift+Enter html: ${shiftEnter.html}  innerText: ${JSON.stringify(shiftEnter.text)}`);
check('[c] Shift+Enter gives a newline', shiftEnter.text, 'a\nb');
const brEnter = await type('d', keys('a\nb'), 'shift_enter');
check('[d] Shift+Enter inserts <br> when white-space is normal', brEnter.html.includes('<br>'), true);
const be = shiftEnter.log.filter((e) => e.type === 'beforeinput').map((e) => e.inputType);
check('[c] Shift+Enter is insertLineBreak', be.includes('insertLineBreak'), true);
const be2 = enter.log.filter((e) => e.type === 'beforeinput').map((e) => e.inputType);
check('[c] Enter is insertParagraph', be2.includes('insertParagraph'), true);
const ins = (await type('t', keys('é'))).log.filter((e) => e.type === 'beforeinput');
check('insertText fires beforeinput insertText', ins.map((e) => `${e.inputType}:${e.data}`).join(), 'insertText:é');

console.log(failures ? `\n${failures} FAILED` : '\nall probes passed');
await chrome.close();
process.exit(failures ? 1 : 0);
