// chrome.debugger session for one typing job. Attached only for the job's
// duration; Chrome shows its "started debugging this browser" bar meanwhile.
import { strokeFor } from './keys.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Debuggee {
  static async attach(tabId) {
    const target = { tabId };
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      throw new Error(`could not attach to the tab: ${e.message}`);
    }
    const d = new Debuggee(target);
    // Typing works even when Chrome isn't the frontmost app.
    await d.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return d;
  }

  constructor(target) {
    this.target = target;
    this.detachedReason = null;
    this.onDetach = (source, reason) => {
      if (source.tabId === target.tabId) this.detachedReason = reason;
    };
    chrome.debugger.onDetach.addListener(this.onDetach);
  }

  send(method, params = {}) {
    if (this.detachedReason) {
      const why = this.detachedReason === 'canceled_by_user' ? 'Chrome\'s debugging bar was cancelled' : this.detachedReason;
      return Promise.reject(new Error(`debugger detached: ${why}`));
    }
    return chrome.debugger.sendCommand(this.target, method, params);
  }

  // One planned op as real input: key down(s), hold, key up(s); or an
  // insertText for characters with no US key.
  async stroke(op, newline, hold = 0) {
    const s = strokeFor(op, newline);
    if (s.insertText !== undefined) return this.send('Input.insertText', { text: s.insertText });
    for (const p of s.downs) await this.send('Input.dispatchKeyEvent', p);
    if (hold) await sleep(hold);
    for (const p of s.ups) await this.send('Input.dispatchKeyEvent', p);
  }

  async detach() {
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (this.detachedReason) return;
    try { await chrome.debugger.detach(this.target); } catch { /* tab already gone */ }
  }
}
