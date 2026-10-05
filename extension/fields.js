// Finding and reading fields from the service worker. Field ids are
// "f3" in the top frame and "f3@<frameId>" inside iframes.
import { typistDoc, typistPage } from './page.js';

const FIELD_ID = /^(f\d+)(?:@(\d+))?$/;

export async function inFrame(tabId, frameId, cmd, arg) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: typistPage,
    args: [cmd, arg],
  });
  const result = res?.result;
  if (!result) throw new Error('the page did not respond (it may have navigated)');
  if (result.error) throw new Error(result.error);
  return result;
}

export async function inDoc(tabId, cmd) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: typistDoc, args: [cmd] });
  const result = res?.result;
  if (!result) throw new Error('the page did not respond (it may have navigated)');
  if (result.error) throw new Error(result.error);
  return result;
}

// The export redirects to another Google host, which CORS blocks inside the
// page; the service worker's host permission lets it follow the redirect.
export async function readDoc(exportUrl) {
  const res = await fetch(exportUrl, { cache: 'no-store', credentials: 'include' });
  if (!res.ok) throw new Error(`could not read the document back (HTTP ${res.status})`);
  if (!res.headers.get('content-type')?.startsWith('text/plain')) {
    throw new Error('could not read the document back (Google returned a page instead of text; is this Chrome profile signed in to the doc\'s account?)');
  }
  return { text: (await res.text()).replace(/^\uFEFF/, '') };
}

async function inAllFrames(tabId, cmd, arg = {}) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: typistPage,
    args: [cmd, arg],
  });
  return results.filter((r) => r.result && !r.result.error);
}

const publicId = (localId, frameId) => (frameId === 0 ? localId : `${localId}@${frameId}`);

export async function listFields(tabId) {
  const frames = await inAllFrames(tabId, 'list');
  return frames.flatMap(({ frameId, result }) =>
    result.fields.map((f) => ({ ...f, id: publicId(f.id, frameId), ...(frameId && { frame: frameId }) })));
}

// target: undefined (focused field), a field id from list_fields, or a CSS
// selector (top frame). Returns { frameId, localId, id, field }.
export async function resolveTarget(tabId, target) {
  if (!target) {
    const frames = (await inAllFrames(tabId, 'focused')).filter((r) => r.result.field);
    // Each frame keeps its own activeElement; prefer the top frame, then
    // the frame that actually has focus.
    const pick = frames.find((r) => r.frameId === 0)
      ?? (frames.length === 1 ? frames[0] : frames.find((r) => r.result.hasFocus));
    if (!pick) {
      throw new Error(frames.length
        ? 'several frames have a focused field; call list_fields and pass a target id'
        : 'no text field is focused on the active tab; click into one, or call list_fields and pass a target');
    }
    const field = pick.result.field;
    return { frameId: pick.frameId, localId: field.id, id: publicId(field.id, pick.frameId), field };
  }
  const m = FIELD_ID.exec(target);
  if (m) {
    const frameId = Number(m[2] ?? 0);
    const { field } = await inFrame(tabId, frameId, 'select', { selector: `[data-typist-id="${m[1]}"]` })
      .catch(() => { throw new Error(`field ${target} not found; the page may have changed, call list_fields again`); });
    return { frameId, localId: m[1], id: target, field };
  }
  const { field } = await inFrame(tabId, 0, 'select', { selector: target });
  return { frameId: 0, localId: field.id, id: field.id, field };
}
