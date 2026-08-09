import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAll, classifyRow, summarize } from '../classify.ts';
import { SERVICE_FIELD } from '../diff.ts';
import type { ChangeRow } from '../types.ts';

function row(partial: Partial<ChangeRow>): ChangeRow {
  return {
    service: 'api',
    field: 'cpuMode',
    before: 'SHARED',
    after: 'DEDICATED',
    ...partial,
  } as ChangeRow;
}

test('scale fields are reversible', () => {
  for (const field of [
    'cpuMode',
    'minCpu',
    'maxCpu',
    'minRam',
    'maxRam',
    'minDisk',
    'maxDisk',
    'minContainers',
    'maxContainers',
  ]) {
    assert.equal(classifyRow(row({ field })).verdict, 'REVERSIBLE', field);
  }
});

test('subdomain access is reversible', () => {
  assert.equal(
    classifyRow(row({ field: 'subdomainAccess', before: false, after: true })).verdict,
    'REVERSIBLE',
  );
});

test('env changes need a restart', () => {
  assert.equal(classifyRow(row({ field: 'env.LOG_LEVEL' })).verdict, 'REVERSIBLE_WITH_RESTART');
  assert.equal(
    classifyRow(row({ field: 'envSecrets.DATABASE_URL' })).verdict,
    'REVERSIBLE_WITH_RESTART',
  );
});

test('HA mode cannot be undone, zerops_scale cannot write it', () => {
  const r = classifyRow(row({ field: 'mode', before: 'NON_HA', after: 'HA' }));
  assert.equal(r.verdict, 'CANNOT_UNDO');
  assert.match(r.reason ?? '', /fixed at service creation/i);
});

test('core package upgrade is one-way and says so', () => {
  const r = classifyRow(row({ field: 'corePackage', before: 'LIGHT', after: 'SERIOUS' }));
  assert.equal(r.verdict, 'CANNOT_UNDO');
  assert.match(r.reason ?? '', /one-way/i);
  assert.match(r.reason ?? '', /logs and statistics are lost/i);
});

test('hostname and type cannot be undone', () => {
  assert.equal(classifyRow(row({ field: 'hostname' })).verdict, 'CANNOT_UNDO');
  assert.equal(classifyRow(row({ field: 'type' })).verdict, 'CANNOT_UNDO');
});

test('service deletion states plainly that data is gone', () => {
  const r = classifyRow(
    row({ service: 'worker', field: SERVICE_FIELD, before: 'existed', after: null }),
  );
  assert.equal(r.verdict, 'CANNOT_UNDO');
  assert.match(r.reason ?? '', /Its data is gone and cannot be recovered/);
  assert.match(r.reason ?? '', /Configuration can be restored from snapshot/);
});

test('service creation is reversible', () => {
  const r = classifyRow(
    row({ service: 'cache', field: SERVICE_FIELD, before: null, after: 'created' }),
  );
  assert.equal(r.verdict, 'REVERSIBLE');
});

test('unknown fields default to CANNOT_UNDO, never claim a reversal we cannot do', () => {
  const r = classifyRow(row({ field: 'someFutureZeropsField' }));
  assert.equal(r.verdict, 'CANNOT_UNDO');
  assert.match(r.reason ?? '', /no known mutation tool writes it/i);
});

test('every CANNOT_UNDO row carries a human-readable reason', () => {
  const rows = classifyAll([
    row({ field: 'mode' }),
    row({ field: 'corePackage' }),
    row({ field: 'weirdField' }),
    row({ field: SERVICE_FIELD, before: 'existed', after: null }),
  ]);

  for (const r of rows) {
    assert.equal(r.verdict, 'CANNOT_UNDO');
    assert.ok(r.reason && r.reason.length > 20, `missing reason for ${r.field}`);
  }
});

test('summarize counts by verdict and collects residue', () => {
  const s = summarize(
    classifyAll([
      row({ field: 'cpuMode' }),
      row({ field: 'maxContainers' }),
      row({ field: 'env.LOG_LEVEL' }),
      row({ field: 'mode' }),
    ]),
  );

  assert.equal(s.reversible, 2);
  assert.equal(s.withRestart, 1);
  assert.equal(s.cannotUndo, 1);
  assert.equal(s.residue.length, 1);
  assert.equal(s.fullyReversible, false);
});

test('fullyReversible is true only when nothing is irreversible', () => {
  const s = summarize(classifyAll([row({ field: 'cpuMode' }), row({ field: 'env.X' })]));
  assert.equal(s.fullyReversible, true);
  assert.equal(s.residue.length, 0);
});
