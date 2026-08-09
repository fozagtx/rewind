import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, valuesEqual, SERVICE_FIELD } from '../diff.ts';
import { buildSnapshot, hashContent, parseExport, serviceToImportYaml } from '../snapshot.ts';
import type { ProjectSnapshot } from '../types.ts';

function snap(raw: string, id: string): ProjectSnapshot {
  return buildSnapshot({
    projectId: 'proj-1',
    raw,
    trigger: 'manual',
    artifactKey: `k/${id}`,
    id,
    capturedAt: '2026-08-09T00:00:00.000Z',
  });
}

const BASE = `
services:
  - hostname: api
    type: nodejs@22
    cpuMode: SHARED
    minRam: 0.25
    maxContainers: 2
    envVariables:
      LOG_LEVEL: info
    secretEnvVariables:
      DATABASE_URL: postgresql://user:hunter2@db:5432/app
  - hostname: worker
    type: nodejs@22
    cpuMode: SHARED
`;

test('parses services keyed by hostname', () => {
  const services = parseExport(BASE);
  assert.deepEqual(Object.keys(services).sort(), ['api', 'worker']);
  assert.equal(services.api?.type, 'nodejs@22');
});

test('hashContent is stable and differs on change', () => {
  assert.equal(hashContent(BASE), hashContent(BASE));
  assert.notEqual(hashContent(BASE), hashContent(BASE + '\n'));
});

test('numeric equality ignores formatting', () => {
  assert.ok(valuesEqual(4, 4.0));
  assert.ok(valuesEqual('4', 4));
  assert.ok(!valuesEqual(4, 5));
  assert.ok(valuesEqual(null, undefined));
});

test('no changes yields an empty changeset', () => {
  const rows = diffSnapshots(snap(BASE, 'a'), snap(BASE, 'b'));
  assert.deepEqual(rows, []);
});

test('detects scale change', () => {
  const after = BASE.replace('cpuMode: SHARED\n    minRam: 0.25', 'cpuMode: DEDICATED\n    minRam: 0.25');
  const rows = diffSnapshots(snap(BASE, 'a'), snap(after, 'b'));
  const row = rows.find((r) => r.service === 'api' && r.field === 'cpuMode');
  assert.ok(row, 'expected a cpuMode row');
  assert.equal(row.before, 'SHARED');
  assert.equal(row.after, 'DEDICATED');
});

test('service deletion is detected', () => {
  const after = BASE.replace(/  - hostname: worker[\s\S]*$/, '');
  const rows = diffSnapshots(snap(BASE, 'a'), snap(after, 'b'));
  const row = rows.find((r) => r.service === 'worker' && r.field === SERVICE_FIELD);
  assert.ok(row, 'expected a service deletion row');
  assert.equal(row.before, 'existed');
  assert.equal(row.after, null);
});

test('service creation is detected', () => {
  const after = BASE + '  - hostname: cache\n    type: valkey@7.2\n';
  const rows = diffSnapshots(snap(BASE, 'a'), snap(after, 'b'));
  const row = rows.find((r) => r.service === 'cache' && r.field === SERVICE_FIELD);
  assert.ok(row);
  assert.equal(row.before, null);
  assert.equal(row.after, 'created');
});

test('env var added, changed, and removed are all detected', () => {
  const after = BASE.replace(
    'envVariables:\n      LOG_LEVEL: info',
    'envVariables:\n      LOG_LEVEL: debug\n      FEATURE_X: "1"',
  );
  const rows = diffSnapshots(snap(BASE, 'a'), snap(after, 'b'));

  const changed = rows.find((r) => r.field === 'env.LOG_LEVEL');
  assert.ok(changed);
  assert.equal(changed.before, 'info');
  assert.equal(changed.after, 'debug');

  const added = rows.find((r) => r.field === 'env.FEATURE_X');
  assert.ok(added);
  assert.equal(added.before, null);

  const removedAfter = BASE.replace('    envVariables:\n      LOG_LEVEL: info\n', '');
  const removedRows = diffSnapshots(snap(BASE, 'a'), snap(removedAfter, 'b'));
  const removed = removedRows.find((r) => r.field === 'env.LOG_LEVEL');
  assert.ok(removed);
  assert.equal(removed.after, null);
});

test('secret values NEVER appear in any output row', () => {
  const after = BASE.replace('hunter2', 'correcthorse');
  const rows = diffSnapshots(snap(BASE, 'a'), snap(after, 'b'));
  const serialized = JSON.stringify(rows);

  assert.ok(!serialized.includes('hunter2'), 'old secret leaked');
  assert.ok(!serialized.includes('correcthorse'), 'new secret leaked');

  const row = rows.find((r) => r.field === 'envSecrets.DATABASE_URL');
  assert.ok(row, 'expected a redacted secret row');
  assert.equal(row.redacted, true);
  assert.equal(row.before, '(set)');
  assert.equal(row.after, '(set)');
});

test('row ordering is deterministic across runs', () => {
  const after = BASE
    .replace('cpuMode: SHARED\n    minRam: 0.25', 'cpuMode: DEDICATED\n    minRam: 0.5')
    .replace('LOG_LEVEL: info', 'LOG_LEVEL: debug');

  const first = JSON.stringify(diffSnapshots(snap(BASE, 'a'), snap(after, 'b')));
  const second = JSON.stringify(diffSnapshots(snap(BASE, 'a'), snap(after, 'b')));
  assert.equal(first, second);
});

test('volatile runtime fields are ignored', () => {
  const withNoise = BASE.replace(
    '  - hostname: api\n',
    '  - hostname: api\n    id: svc-abc\n    status: RUNNING\n',
  );
  const rows = diffSnapshots(snap(BASE, 'a'), snap(withNoise, 'b'));
  assert.deepEqual(rows, [], 'runtime state must not produce phantom rows');
});

test('serviceToImportYaml round-trips through parseExport', () => {
  const services = parseExport(BASE);
  const api = services.api;
  assert.ok(api);
  const reparsed = parseExport(serviceToImportYaml(api));
  assert.equal(reparsed.api?.hostname, 'api');
  assert.equal(reparsed.api?.type, 'nodejs@22');
  assert.equal(reparsed.api?.cpuMode, 'SHARED');
});
