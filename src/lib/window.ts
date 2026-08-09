/**
 * Time-window parsing and baseline selection.
 *
 * Lives in lib rather than cli because both the CLI and the HTTP service need
 * it, and importing from the CLI would execute its entry point.
 */

import type { ProjectSnapshot } from './types.ts';

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
 * Newest snapshot at or before `window` ago.
 *
 * Falls back to the oldest snapshot held when none is old enough, so a short
 * session still has something to rewind to.
 */
export function pickBaseline(
  snaps: ProjectSnapshot[],
  window: string,
): ProjectSnapshot | undefined {
  const cutoff = Date.now() - parseWindow(window);
  const eligible = snaps.filter((s) => Date.parse(s.capturedAt) <= cutoff);
  return eligible.length > 0 ? eligible[eligible.length - 1] : snaps[0];
}
