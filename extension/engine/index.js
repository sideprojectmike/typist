// Entry point for the job manager: text + resolved settings -> timed plan.
import { assignDelays } from './timing.js';
import { buildPlan } from './planner.js';
import { createRng, randomSeed } from './rng.js';

export { DEFAULTS, OVERRIDABLE, resolveSettings, validateSettings } from './settings.js';
export { PlanError, replay } from './buffer.js';

export function createTypingPlan(text, settings, seed = randomSeed()) {
  const rng = createRng(seed);
  const { ops, duration_ms } = assignDelays(buildPlan(text, settings, rng), text, settings, rng);
  return {
    seed,
    ops,
    duration_ms,
    stats: {
      keystrokes: ops.filter((op) => op.type === 'key' || op.type === 'backspace').length,
      mistakes: ops.filter((op) => op.type === 'notice').length,
    },
  };
}
