import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow, pickBaseline } from '../window.ts';
import type { ProjectSnapshot, SnapshotTrigger } from '../types.ts';

function snap(minutesAgo: number, trigger: SnapshotTrigger, id: string): ProjectSnapshot {
  return {
    id,
    projectId: 'p',
    capturedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    trigger,
    artifactKey: `k/${id}`,
    contentHash: id,
    services: {},
  };
}

test('parseWindow handles every unit', () => {
  assert.equal(parseWindow('30s'), 30_000);
  assert.equal(parseWindow('20m'), 1_200_000);
  assert.equal(parseWindow('2h'), 7_200_000);
  assert.equal(parseWindow('1d'), 86_400_000);
});

test('parseWindow rejects nonsense rather than guessing', () => {
  assert.throws(() => parseWindow('soon'));
  assert.throws(() => parseWindow('5'));
  assert.throws(() => parseWindow(''));
});

test('with no window, the baseline is the most recent restore point', () => {
  const snaps = [snap(60, 'manual', 'old'), snap(5, 'manual', 'recent')];
  assert.equal(pickBaseline(snaps)?.id, 'recent', 'undo should mean "since I last saved"');
});

test('a dry run must not become the baseline', () => {
  // Regression. A dry run used to store a pre-mutation snapshot of the drifted
  // state, so the next undo compared the mess against itself and reported
  // nothing to do.
  const snaps = [
    snap(10, 'manual', 'restore-point'),
    snap(1, 'pre-mutation', 'bookkeeping'),
  ];
  assert.equal(pickBaseline(snaps)?.id, 'restore-point');
});

test('post-replay bookkeeping is never a baseline either', () => {
  const snaps = [
    snap(10, 'manual', 'restore-point'),
    snap(2, 'post-replay', 'after-undo'),
  ];
  assert.equal(pickBaseline(snaps)?.id, 'restore-point');
});

test('cron snapshots count as restore points', () => {
  const snaps = [snap(30, 'manual', 'manual-one'), snap(3, 'cron', 'cron-one')];
  assert.equal(pickBaseline(snaps)?.id, 'cron-one');
});

test('a window reaches further back than the newest restore point', () => {
  const snaps = [
    snap(60, 'manual', 'hour-ago'),
    snap(30, 'manual', 'half-hour-ago'),
    snap(1, 'manual', 'just-now'),
  ];
  assert.equal(pickBaseline(snaps, '20m')?.id, 'half-hour-ago');
  assert.equal(pickBaseline(snaps, '45m')?.id, 'hour-ago');
});

test('a window with nothing old enough falls back to the oldest restore point', () => {
  // Reporting no drift when drift plainly exists would be the worse failure.
  const snaps = [snap(2, 'manual', 'only-one')];
  assert.equal(pickBaseline(snaps, '20m')?.id, 'only-one');
});

test('no restore points at all yields undefined', () => {
  assert.equal(pickBaseline([]), undefined);
  assert.equal(pickBaseline([snap(1, 'pre-mutation', 'bookkeeping-only')]), undefined);
});
