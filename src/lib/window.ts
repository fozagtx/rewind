/**
 * Time-window parsing and baseline selection.
 *
 * Lives in lib rather than cli because both the CLI and the HTTP service need
 * it, and importing from the CLI would execute its entry point.
 */

import type { ProjectSnapshot } from './types.ts';
import { RESTORE_POINT_TRIGGERS } from './types.ts';

/** Parse a window like `30s`, `20m`, `2h`, `1d` into milliseconds. */
export function parseWindow(w: string): number {
  const m = w.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m || !m[1] || !m[2]) {
    throw new Error(`Invalid window "${w}". Use e.g. 30s, 20m, 2h, 1d.`);
  }

  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult =
    unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;

  return n * mult;
}

/**
 * Pick the snapshot to restore back to.
 *
 * With no window, the baseline is simply the most recent snapshot. That is the
 * obvious reading of "undo what just happened", and it is the common case:
 * take a snapshot, something changes your infrastructure, put it back.
 *
 * With a window, it is the newest snapshot at least that old, which is the
 * time-travel case: "put it back the way it was twenty minutes ago". An earlier
 * version made the window mandatory, so `--to 5m` taken right after a snapshot
 * would skip past it and report no drift. That was confusing and wrong.
 */
export function pickBaseline(
  all: ProjectSnapshot[],
  window?: string,
): ProjectSnapshot | undefined {
  // Only restore points are candidates. Bookkeeping snapshots record the
  // drifted state, so selecting one would compare the mess against itself.
  const snaps = all.filter((s) => RESTORE_POINT_TRIGGERS.includes(s.trigger));

  if (snaps.length === 0) return undefined;
  if (!window) return snaps[snaps.length - 1];

  const cutoff = Date.now() - parseWindow(window);
  const eligible = snaps.filter((s) => Date.parse(s.capturedAt) <= cutoff);

  // Nothing is old enough, so fall back to the oldest held rather than
  // reporting no drift when drift plainly exists.
  return eligible.length > 0 ? eligible[eligible.length - 1] : snaps[0];
}
