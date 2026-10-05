// Runs inside the page (chrome.scripting.executeScript, isolated world).
// chrome.scripting serialises this function, so it must not reference
// anything outside its own body.
//
// Field ids are stored as data-typist-id on the element, so they survive
// between calls as long as the element does.
export function typistPage(cmd, arg = {}) {
  const INPUT_TYPES = ['text', 'search', 'url', 'tel', 'password', 'email'];

  const kindOf = (el) => {
    if (el instanceof HTMLTextAreaElement) return 'textarea';
    if (el instanceof HTMLInputElement && INPUT_TYPES.includes(el.type)) return 'input';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'contenteditable';
    return null;
  };
  const usable = (el) => {
    const kind = kindOf(el);
    if (!kind) return false;
    if ((kind === 'input' || kind === 'textarea') && (el.disabled || el.readOnly)) return false;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  // Climb from a focused node inside an editor to the editor root.
  const editableRoot = (el) => {
    if (!el?.isContentEditable) return el;
    while (el.parentElement?.isContentEditable) el = el.parentElement;
    return el;
  };
  const deepActive = () => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return editableRoot(a);
  };
  const allElements = (root = document) => {
    const out = [];
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) out.push(...allElements(el.shadowRoot));
    }
    return out;
  };

  const idOf = (el) => {
    if (!el.dataset.typistId) {
      globalThis.__typistSeq = (globalThis.__typistSeq ?? 0) + 1;
      el.dataset.typistId = `f${globalThis.__typistSeq}`;
    }
    return el.dataset.typistId;
  };
  const byId = (id) => allElements().find((el) => el.dataset?.typistId === id) ?? null;

  // Text of a contenteditable as the user sees it: blocks on separate lines,
  // <br> as a newline, and the placeholder <br> that ends a block dropped.
  // innerText isn't used because it puts blank lines between <p> elements.
  const blockText = (root) => {
    const lines = [];
    let cur = null;
    const flush = () => {
      if (cur === null) return;
      lines.push(cur.endsWith('\n') ? cur.slice(0, -1) : cur);
      cur = null;
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          let t = child.data;
          const ws = getComputedStyle(child.parentElement).whiteSpace;
          if (ws === 'normal' || ws === 'nowrap') {
            if (!/\S/.test(t) && /\n/.test(t)) continue; // source formatting between tags
            t = t.replace(/[\t\n\r ]+/g, ' ');
          }
          cur = (cur ?? '') + t;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const style = getComputedStyle(child);
          if (style.display === 'none') continue;
          if (child.tagName === 'BR') { cur = (cur ?? '') + '\n'; continue; }
          const block = !style.display.startsWith('inline') && style.display !== 'contents';
          if (block) flush();
          walk(child);
          if (block) flush();
        }
      }
    };
    walk(root);
    flush();
    return lines.join('\n');
  };
  const textOf = (el) => (kindOf(el) === 'contenteditable' ? blockText(el) : el.value);

  const labelOf = (el) => {
    const byIds = el.getAttribute('aria-labelledby')?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
    return (el.getAttribute('aria-label') || byIds || el.labels?.[0]?.textContent
      || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.name || el.title || '')
      .trim().replace(/\s+/g, ' ').slice(0, 80);
  };
  const describe = (el) => {
    const text = textOf(el);
    return {
      id: idOf(el),
      kind: kindOf(el),
      ...(el.type && kindOf(el) === 'input' && { type: el.type }),
      label: labelOf(el),
      value_preview: el.type === 'password' ? '•'.repeat(text.length) : text.slice(0, 60),
      length: text.length,
      focused: deepActive() === el,
    };
  };

  const caretToEnd = (el) => {
    let node = el;
    while (node.lastChild && node.lastChild.nodeName !== 'BR') node = node.lastChild;
    const range = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) range.setStart(node, node.length);
    else if (node.lastChild?.nodeName === 'BR') range.setStartBefore(node.lastChild);
    else { range.selectNodeContents(node); range.collapse(false); }
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const hasSelectionApi = (el) => { try { return el.selectionStart !== null; } catch { return false; } };

  const target = () => {
    const el = byId(arg.id);
    if (!el) throw new Error(`field ${arg.id} is no longer on the page`);
    return el;
  };

  try {
    switch (cmd) {
      case 'list':
        return { fields: allElements().filter(usable).map(describe), hasFocus: document.hasFocus() };

      case 'focused': {
        const el = deepActive();
        return { field: el && usable(el) ? describe(el) : null, hasFocus: document.hasFocus() };
      }

      case 'select': {
        const el = editableRoot(document.querySelector(arg.selector));
        if (!el) return { error: `no element matches ${arg.selector}` };
        if (!usable(el)) return { error: `${arg.selector} is not a visible, editable text field` };
        return { field: describe(el) };
      }

      // Focus the field and record its state before typing. The caret goes
      // to the end unless the field was already focused (then the user's
      // caret or selection in an input/textarea is kept). Contenteditable
      // always types at the end.
      case 'prepare': {
        const el = target();
        const kind = kindOf(el);
        const wasFocused = deepActive() === el;
        el.focus();
        const initial = textOf(el);
        const base = { kind, initial, maxLength: el.maxLength > 0 ? el.maxLength : null };
        if (arg.mode === 'replace') {
          if (kind === 'contenteditable') getSelection().selectAllChildren(el); else el.select();
          return { ...base, before: '', after: '', needsClear: initial !== '' };
        }
        if (kind === 'contenteditable') {
          caretToEnd(el);
          return { ...base, before: initial, after: '', needsClear: false };
        }
        if (!hasSelectionApi(el)) {
          if (initial) return { error: `can't find the caret in a type=${el.type} field that has text; use mode "replace"` };
          return { ...base, before: '', after: '', needsClear: false };
        }
        if (!wasFocused) el.setSelectionRange(initial.length, initial.length);
        return { ...base, before: initial.slice(0, el.selectionStart), after: initial.slice(el.selectionEnd), needsClear: false };
      }

      case 'read': {
        const el = target();
        return { text: textOf(el), focused: deepActive() === el };
      }

      case 'isFocused':
        return { focused: deepActive() === byId(arg.id) };

      // Put focus and caret back where typing left off (caret = UTF-16
      // offset for inputs/textareas; contenteditable types at the end).
      case 'refocus': {
        const el = target();
        el.focus();
        if (kindOf(el) === 'contenteditable') caretToEnd(el);
        else if (hasSelectionApi(el) && arg.caret != null) el.setSelectionRange(arg.caret, arg.caret);
        return { focused: deepActive() === el };
      }

      default:
        return { error: `unknown command ${cmd}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Google Docs (top frame). Docs draws text on a canvas and takes keys in a
// hidden contenteditable inside .docs-texteventtarget-iframe. The text is
// read back from the service worker (readDoc in fields.js), not from here.
export function typistDoc(cmd) {
  try {
    const frame = document.querySelector('.docs-texteventtarget-iframe');
    const editor = frame?.contentDocument?.querySelector('[contenteditable]');
    if (!editor) return { error: 'can\'t find the Google Docs editor on this page; wait for it to load, or use a regular document tab' };
    const focused = () => document.activeElement === frame && frame.contentDocument.activeElement === editor;
    if (cmd === 'isFocused') return { focused: focused() };
    if (cmd === 'refocus') { editor.focus(); return { focused: focused() }; }
    return { error: `unknown command ${cmd}` };
  } catch (e) {
    return { error: e.message };
  }
}
