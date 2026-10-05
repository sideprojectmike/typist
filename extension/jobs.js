// Job manager: runs one type_text job at a time, from field preparation to
// final verification. Either the field is read back and matches exactly, or
// the result has ok: false.
import { Debuggee } from './cdp.js';
import { createTypingPlan, resolveSettings } from './engine/index.js';
import { msPerChar } from './engine/timing.js';
import { inDoc, inFrame, readDoc, resolveTarget } from './fields.js';
import { diagnose, expectedText, firstDifference, insertedAt, normalize } from './verify.js';

const MAX_REPAIRS = 3;
const MAX_REFOCUS = 3;
const SETTLE_MS = 150; // let async editors (React, Quill) finish before the final read
const DOC_SAVE_WAIT_MS = 15000; // Docs saves a second or two after typing stops; the export only shows saved text
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UNSUPPORTED = [
  [/^(chrome|edge|about|chrome-extension|devtools):/, 'Chrome does not let extensions type into its own pages'],
  [/^https:\/\/chromewebstore\.google\.com\//, 'Chrome does not let extensions type into the Web Store'],
  [/^https:\/\/docs\.google\.com\/(presentation|spreadsheets)\//,
    'Google Slides and Sheets draw text on a canvas, so the result can\'t be read back to verify it. Typist refuses rather than report an unverified result'],
];
const GOOGLE_DOC = /^(https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/[\w-]+)/;

class JobError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

let current = null;

export function cancelJob() {
  if (!current) return { cancelled: false, message: 'no typing job is running' };
  current.cancelled = true;
  return { cancelled: true };
}

export async function runJob(params, onProgress = () => {}) {
  // A cancelled job stops at its next keystroke; give it a moment to finish.
  for (let i = 0; i < 40 && current?.cancelled; i++) await sleep(50);
  if (current) return { ok: false, verified: false, error: 'another typing job is already running' };
  const job = new TypingJob(onProgress);
  current = job;
  try {
    return await job.run(params ?? {});
  } catch (e) {
    return { ok: false, verified: false, error: e.message, ...e.extra, ...(job.seed !== undefined && { seed: job.seed }) };
  } finally {
    current = null;
  }
}

const popGrapheme = (s) => {
  const segs = [...new Intl.Segmenter().segment(s)];
  return segs.length ? s.slice(0, segs.at(-1).index) : s;
};

class TypingJob {
  constructor(onProgress) {
    this.onProgress = onProgress;
    this.cancelled = false;
    this.repairs = 0;
    this.refocuses = 0;
    this.typed = ''; // what this job has put in the field so far, between state.before and state.after
  }

  async run({ text, target, wpm, mode, newline }) {
    if (typeof text !== 'string') throw new JobError('text must be a string');
    const { settings: stored } = await chrome.storage.sync.get('settings');
    this.settings = resolveSettings(stored, { wpm, mode, newline });
    this.text = text.replace(/\r\n?/g, '\n');
    this.chars = Array.from(this.text);

    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new JobError('no active tab');
    for (const [pattern, why] of UNSUPPORTED) if (pattern.test(tab.url ?? '')) throw new JobError(why);

    const doc = GOOGLE_DOC.exec(tab.url ?? '');
    if (doc) {
      // Google Docs: type at the document's own caret; `target` doesn't apply.
      if (this.settings.mode === 'replace') throw new JobError('mode "replace" isn\'t supported in Google Docs; select the text yourself and use "insert"');
      this.isDoc = true;
      this.field = { id: 'document' };
      this.page = (cmd) => (cmd === 'read' ? readDoc(`${doc[1]}/export?format=txt`) : inDoc(tab.id, cmd));
      this.docBefore = (await this.page('read')).text;
      this.state = { kind: 'document', before: '', after: '', needsClear: false };
    } else {
      this.field = await resolveTarget(tab.id, target);
      this.page = (cmd, arg = {}) => inFrame(tab.id, this.field.frameId, cmd, { id: this.field.localId, ...arg });
      this.state = await this.page('prepare', { mode: this.settings.mode });
    }
    this.baseline = this.state.needsClear ? '' : this.state.initial;

    if (this.state.kind === 'input' && this.text.includes('\n')) {
      throw new JobError('the target is a single-line input, so the text can\'t contain newlines');
    }
    const finalLength = (this.state.before + this.text + this.state.after).length;
    if (this.state.maxLength && finalLength > this.state.maxLength) {
      throw new JobError(`the field allows ${this.state.maxLength} characters; the result would be ${finalLength}`);
    }

    // Plan, including the virtual-buffer proof (buildPlan throws if the plan
    // would not end on exactly the text).
    const plan = createTypingPlan(this.text, this.settings);
    this.seed = plan.seed;

    this.dbg = await Debuggee.attach(tab.id);
    const started = performance.now();
    try {
      if (this.state.needsClear) await this.clear();
      await this.execute(plan.ops);
      await sleep(SETTLE_MS);
      if (this.isDoc) await this.verifyDoc();
      else await this.checkpoint(this.chars.length); // final, exact verification
    } finally {
      await this.dbg.detach();
    }

    const duration = Math.round(performance.now() - started);
    return {
      ok: true,
      verified: true,
      final_text: normalize(this.lastRead),
      target: this.field.id,
      mistakes: plan.stats.mistakes,
      repairs: this.repairs,
      duration_ms: duration,
      effective_wpm: duration ? Math.round((this.chars.length / 5) / (duration / 60000) * 10) / 10 : 0,
      seed: plan.seed,
    };
  }

  // Ops run on an absolute schedule so page round-trips don't slow typing.
  // If the schedule falls behind (after a repair, say) it restarts from now
  // rather than bursting keys to catch up.
  async execute(ops) {
    let clock = performance.now();
    for (const op of ops) {
      this.checkCancelled();
      if (op.type === 'checkpoint') {
        if (!this.isDoc) await this.checkpoint(op.at); // Docs can't be read back mid-typing
        this.onProgress({ done: op.at, total: this.chars.length });
        continue;
      }
      clock += op.delay;
      const wait = clock - performance.now();
      if (wait > 0) await sleep(wait);
      else clock = performance.now();
      if (op.type !== 'notice') await this.key(op, op.hold);
    }
  }

  checkCancelled() {
    if (this.cancelled) throw new JobError('cancelled', { cancelled: true, ...(this.lastRead !== undefined && { final_text: this.lastRead }) });
  }

  async key(op, hold) {
    this.checkCancelled();
    await this.ensureFocus();
    await this.dbg.stroke(op, this.settings.newline, hold);
    this.typed = op.type === 'backspace' ? popGrapheme(this.typed) : this.typed + op.char;
  }

  caret() {
    return (this.state.before + this.typed).length;
  }

  // Keys only go out while the target has focus. If focus moved, put it
  // back once things settle, and continue only if the field is exactly as
  // typing left it.
  async ensureFocus() {
    if ((await this.page('isFocused')).focused) return;
    if (++this.refocuses > MAX_REFOCUS) throw new JobError('the field kept losing focus, so typing stopped');
    await sleep(300);
    const refocused = await this.page('refocus', { caret: this.caret() });
    if (this.isDoc) { // can't read Docs mid-typing; verifyDoc catches keys that went astray
      if (!refocused.focused) throw new JobError('could not put focus back on the document; click into it and try again');
      return;
    }
    const { text, focused } = await this.page('read');
    if (!focused) throw new JobError('could not put focus back on the field');
    const want = expectedText(this.state, this.typed);
    if (normalize(text) !== want) {
      throw new JobError(`the field changed while it didn't have focus (${firstDifference(text, want)})`, { final_text: text });
    }
  }

  // Docs: poll the saved document until it holds exactly the old text with
  // this job's text inserted in one piece.
  async verifyDoc() {
    const until = performance.now() + DOC_SAVE_WAIT_MS;
    do {
      await sleep(1000);
      this.lastRead = (await this.page('read')).text;
      if (insertedAt(this.docBefore, this.lastRead, this.text) >= 0) return;
    } while (performance.now() < until);
    throw new JobError('the document doesn\'t hold exactly the typed text. Docs may have auto-corrected it (smart quotes, dashes, lists), or someone else edited it', { final_text: this.lastRead });
  }

  async clear() {
    await this.key({ type: 'backspace' }, 60);
    const { text } = await this.page('read');
    if (normalize(text) !== '') throw new JobError('could not clear the field before typing', { final_text: text });
    this.typed = '';
  }

  // Compare the field with what it should hold once `at` characters of the
  // text are typed; repair at the caret if it differs.
  async checkpoint(at) {
    const want = expectedText(this.state, this.chars.slice(0, at).join(''));
    for (;;) {
      const { text } = await this.page('read');
      this.lastRead = text;
      const d = diagnose(text, want, this.state);
      if (d.ok) return;
      if (at > 0 && normalize(text) === normalize(this.baseline)) {
        throw new JobError('typed keys did not change the field\'s text. The editor may keep its text somewhere Typist can\'t read, so the result can\'t be verified', { final_text: text });
      }
      if (d.fail) throw new JobError(`${d.fail} (${firstDifference(text, want)})`, { final_text: text });
      if (++this.repairs > MAX_REPAIRS) {
        throw new JobError(`the field still differs after ${MAX_REPAIRS} repairs, so the page is probably auto-correcting or reformatting the text (${firstDifference(text, want)})`, { final_text: text, repairs: MAX_REPAIRS });
      }
      await this.repair(d.repair, text);
    }
  }

  // Backspace to the first wrong character and retype the rest, without mistakes.
  async repair({ keep, backspaces, retype }, actual) {
    this.typed = normalize(actual).slice(this.state.before.length, actual.length - this.state.after.length);
    await this.page('refocus', { caret: actual.length - this.state.after.length });
    const { min, max } = this.settings.correction_pause;
    await sleep(min + Math.random() * (max - min));
    for (let i = 0; i < backspaces; i++) {
      await this.key({ type: 'backspace' }, 40);
      await sleep(msPerChar(this.settings.wpm) * (0.5 + Math.random() * 0.3));
    }
    const { ops } = createTypingPlan(retype, { ...this.settings, mistakes_enabled: false });
    await this.execute(ops.filter((op) => op.type !== 'checkpoint'));
    this.typed = keep.slice(this.state.before.length) + retype;
  }
}
