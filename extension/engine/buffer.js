// Virtual buffer: replays a plan the way the field would receive it (caret at
// the end, keys append, Backspace removes one character) and proves the plan
// ends at exactly the target, with every checkpoint on a correct prefix.
export class PlanError extends Error {}

export function replay(ops) {
  const buf = [];
  for (const op of ops) {
    if (op.type === 'key') buf.push(op.char);
    else if (op.type === 'backspace') {
      if (!buf.length) throw new PlanError('backspace on empty buffer');
      buf.pop();
    }
  }
  return buf.join('');
}

export function assertPlan(ops, text) {
  const target = Array.from(text);
  const buf = [];
  let low = 0; // lowest buffer length since the last checkpoint

  for (const [n, op] of ops.entries()) {
    if (op.type === 'key') buf.push(op.char);
    else if (op.type === 'backspace') {
      if (!buf.length) throw new PlanError(`op ${n}: backspace on empty buffer`);
      buf.pop();
      low = Math.min(low, buf.length);
    } else if (op.type === 'checkpoint') {
      if (buf.length !== op.at) throw new PlanError(`op ${n}: checkpoint at ${op.at} but buffer has ${buf.length}`);
      // Everything below `low` was already verified at the previous checkpoint.
      for (let i = low; i < buf.length; i++) {
        if (buf[i] !== target[i]) throw new PlanError(`op ${n}: checkpoint at ${op.at} differs at ${i}`);
      }
      low = buf.length;
    }
  }

  if (buf.join('') !== text) throw new PlanError('plan does not produce the target text');
  if (ops.at(-1)?.type !== 'checkpoint' || ops.at(-1).at !== target.length) {
    throw new PlanError('plan must end with a checkpoint on the full text');
  }
}
