import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeReplay, formatResidue, planReplay } from '../replay.ts';
import { classifyAll } from '../classify.ts';
import { SERVICE_FIELD } from '../diff.ts';
import { buildSnapshot } from '../snapshot.ts';
import type { ChangeRow, Changeset, ProcessHandle, ScalePatch, ZeropsClient } from '../types.ts';

function changeset(rows: Partial<ChangeRow>[]): Changeset {
  const full = rows.map((r) => ({
    service: 'api',
    field: 'cpuMode',
    before: 'SHARED',
    after: 'DEDICATED',
    ...r,
  })) as ChangeRow[];

  return {
    id: 'cs-1',
    projectId: 'proj-1',
    fromSnapshotId: 'snap-a',
    toSnapshotId: 'snap-b',
    rows: classifyAll(full),
    computedAt: '2026-08-09T00:00:00.000Z',
  };
}

interface Recorded {
  op: string;
  args: unknown[];
}

/**
 * Fake transport, not a fake product. Recording calls at the platform boundary
 * is the only way to assert we send the right reversal without mutating a real
 * project during a test run.
 */
function fakeClient(overrides: Partial<ZeropsClient> = {}) {
  const calls: Recorded[] = [];
  const ok = (): Promise<ProcessHandle> =>
    Promise.resolve({ processId: '', status: 'finished' as const });

  const client: ZeropsClient = {
    exportProject: async () => ({ raw: '', services: {} }),
    listServices: async () => [],
    resolveServiceId: async (_p, hostname) => `id-${hostname}`,
    scale: async (id, patch) => {
      calls.push({ op: 'scale', args: [id, patch] });
      return ok();
    },
    setEnv: async (id, k, v) => {
      calls.push({ op: 'setEnv', args: [id, k, v] });
      return ok();
    },
    deleteEnv: async (id, k) => {
      calls.push({ op: 'deleteEnv', args: [id, k] });
      return ok();
    },
    setSubdomain: async (id, enabled) => {
      calls.push({ op: 'setSubdomain', args: [id, enabled] });
      return ok();
    },
    restart: async (id) => {
      calls.push({ op: 'restart', args: [id] });
      return ok();
    },
    importServices: async (p, yaml) => {
      calls.push({ op: 'importServices', args: [p, yaml] });
      return ok();
    },
    waitForProcess: async (processId) => ({ processId, status: 'finished' as const }),
    ...overrides,
  };

  return { client, calls };
}

test('nine scale fields coalesce into ONE scale step with a merged patch', () => {
  const cs = changeset([
    { field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' },
    { field: 'minCpu', before: 1, after: 4 },
    { field: 'maxCpu', before: 2, after: 8 },
    { field: 'minRam', before: 0.25, after: 4 },
    { field: 'maxContainers', before: 2, after: 6 },
  ]);

  const plan = planReplay(cs);
  const scaleSteps = plan.steps.filter((s) => s.operation === 'scale');

  assert.equal(scaleSteps.length, 1, 'expected exactly one coalesced scale step');
  const patch = scaleSteps[0]?.targetValue as ScalePatch;
  assert.equal(patch.cpuMode, 'SHARED');
  assert.equal(patch.minCpu, 1);
  assert.equal(patch.maxCpu, 2);
  assert.equal(patch.minRam, 0.25);
  assert.equal(patch.maxContainers, 2);
});

test('targetValue restores the BEFORE value, not the after', () => {
  const plan = planReplay(changeset([{ field: 'subdomainAccess', before: false, after: true }]));
  const step = plan.steps.find((s) => s.operation === 'setSubdomain');
  assert.ok(step);
  assert.equal(step.targetValue, false, 'reversal must restore the earlier state');
});

test('an ADDED env var reverses to deleteEnv', () => {
  const plan = planReplay(changeset([{ field: 'env.FEATURE_X', before: null, after: '1' }]));
  const step = plan.steps.find((s) => s.operation === 'deleteEnv');
  assert.ok(step, 'expected a deleteEnv step');
  assert.equal(step.targetValue, 'FEATURE_X');
});

test('a CHANGED env var reverses to setEnv with the old value', () => {
  const plan = planReplay(changeset([{ field: 'env.LOG_LEVEL', before: 'info', after: 'debug' }]));
  const step = plan.steps.find((s) => s.operation === 'setEnv');
  assert.ok(step);
  assert.deepEqual(step.targetValue, { key: 'LOG_LEVEL', value: 'info' });
});

test('a changed SECRET becomes residue, we never stored the old value', () => {
  const plan = planReplay(
    changeset([
      {
        field: 'envSecrets.DATABASE_URL',
        before: '(set)',
        after: '(set)',
        redacted: true,
      },
    ]),
  );

  assert.equal(plan.steps.length, 0, 'must not attempt to restore a secret it never held');
  assert.equal(plan.residue.length, 1);
  assert.match(plan.residue[0]?.reason ?? '', /never stores secret values/i);
});

test('CANNOT_UNDO rows produce zero steps and land in residue', () => {
  const cs = changeset([
    { field: 'mode', before: 'NON_HA', after: 'HA' },
    { field: 'corePackage', before: 'LIGHT', after: 'SERIOUS' },
  ]);
  const plan = planReplay(cs);

  assert.equal(plan.steps.length, 0);
  assert.equal(plan.residue.length, 2);
});

test('exactly one restart per service, ordered last for that service', () => {
  const cs = changeset([
    { service: 'api', field: 'env.A', before: '1', after: '2' },
    { service: 'api', field: 'env.B', before: '3', after: '4' },
    { service: 'api', field: 'env.C', before: '5', after: '6' },
  ]);
  const plan = planReplay(cs);

  const restarts = plan.steps.filter((s) => s.operation === 'restart');
  assert.equal(restarts.length, 1, 'three env changes must produce one restart');

  const lastApiStep = plan.steps.filter((s) => s.service === 'api').at(-1);
  assert.equal(lastApiStep?.operation, 'restart');
});

test('step ordering: recreate before scale before env before subdomain before restart', () => {
  const from = buildSnapshot({
    projectId: 'proj-1',
    raw: 'services:\n  - hostname: worker\n    type: nodejs@22\n',
    trigger: 'manual',
    artifactKey: 'k/a',
    id: 'snap-a',
    capturedAt: '2026-08-09T00:00:00.000Z',
  });

  const cs = changeset([
    { service: 'worker', field: SERVICE_FIELD, before: 'existed', after: null },
    { service: 'worker', field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' },
    { service: 'worker', field: 'env.X', before: '1', after: '2' },
    { service: 'worker', field: 'subdomainAccess', before: false, after: true },
  ]);

  const ops = planReplay(cs, from).steps.map((s) => s.operation);
  assert.deepEqual(ops, ['recreateService', 'scale', 'setEnv', 'setSubdomain', 'restart']);
});

test('a deleted service is recreated AND still reported as data loss', () => {
  const from = buildSnapshot({
    projectId: 'proj-1',
    raw: 'services:\n  - hostname: worker\n    type: nodejs@22\n',
    trigger: 'manual',
    artifactKey: 'k/a',
    id: 'snap-a',
    capturedAt: '2026-08-09T00:00:00.000Z',
  });

  const cs = changeset([
    { service: 'worker', field: SERVICE_FIELD, before: 'existed', after: null },
  ]);
  const plan = planReplay(cs, from);

  // Config is restorable, so a recreate step must exist.
  const step = plan.steps.find((s) => s.operation === 'recreateService');
  assert.ok(step, 'expected the configuration to be recreated');
  assert.match(String(step.targetValue), /hostname: worker/);

  // Data is not restorable, so it must still be reported.
  assert.equal(plan.residue.length, 1, 'data loss must be reported even after recreate');
  assert.match(plan.residue[0]?.reason ?? '', /data it held is gone/i);
});

test('a deleted service with no stored config is pure residue', () => {
  const cs = changeset([
    { service: 'ghost', field: SERVICE_FIELD, before: 'existed', after: null },
  ]);

  // No fromSnapshot, so there is no configuration to restore.
  const plan = planReplay(cs);
  assert.equal(plan.steps.length, 0);
  assert.match(plan.residue[0]?.reason ?? '', /no snapshot of its configuration/i);
});

test('a created service is NOT auto-deleted, it becomes residue', () => {
  const plan = planReplay(
    changeset([{ service: 'cache', field: SERVICE_FIELD, before: null, after: 'created' }]),
  );
  assert.equal(plan.steps.length, 0);
  assert.match(plan.residue[0]?.reason ?? '', /never does automatically/i);
});

test('executeReplay sends the right reversal calls', async () => {
  const { client, calls } = fakeClient();
  const plan = planReplay(
    changeset([
      { field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' },
      { field: 'subdomainAccess', before: false, after: true },
    ]),
  );

  const result = await executeReplay(client, 'proj-1', plan);

  assert.equal(result.complete, true);
  assert.ok(calls.some((c) => c.op === 'scale'));
  assert.ok(calls.some((c) => c.op === 'setSubdomain' && c.args[1] === false));
});

test('complete is FALSE when residue exists even if every step succeeded', async () => {
  const { client } = fakeClient();
  const plan = planReplay(
    changeset([
      { field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' },
      { field: 'mode', before: 'NON_HA', after: 'HA' },
    ]),
  );

  const result = await executeReplay(client, 'proj-1', plan);

  assert.ok(result.steps.every((s) => s.status === 'succeeded'), 'steps should succeed');
  assert.equal(result.residue.length, 1);
  assert.equal(
    result.complete,
    false,
    'never report a clean rewind while something could not be undone',
  );
});

test('a failing step does not abort its siblings', async () => {
  const { client } = fakeClient({
    setSubdomain: async () => {
      throw new Error('subdomain service unavailable');
    },
  });

  const plan = planReplay(
    changeset([
      { service: 'api', field: 'subdomainAccess', before: false, after: true },
      { service: 'web', field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' },
    ]),
  );

  const result = await executeReplay(client, 'proj-1', plan);

  const failed = result.steps.find((s) => s.operation === 'setSubdomain');
  const succeeded = result.steps.find((s) => s.operation === 'scale');

  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error ?? '', /unavailable/);
  assert.equal(succeeded?.status, 'succeeded', 'other services must still be reversed');
  assert.equal(result.complete, false);
});

test('dryRun mutates nothing and does not claim steps ran', async () => {
  const { client, calls } = fakeClient();
  const plan = planReplay(changeset([{ field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' }]));

  const result = await executeReplay(client, 'proj-1', plan, { dryRun: true });

  assert.equal(calls.length, 0, 'dry run must not call the platform');
  assert.ok(result.steps.every((s) => s.status === 'pending'));
  assert.equal(result.complete, false);
});

test('onStep streams running then terminal for each step', async () => {
  const { client } = fakeClient();
  const seen: string[] = [];
  const plan = planReplay(changeset([{ field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' }]));

  await executeReplay(client, 'proj-1', plan, {
    onStep: (s) => seen.push(s.status),
  });

  assert.deepEqual(seen, ['running', 'succeeded']);
});

test('waitForProcess failure surfaces as a failed step, not a thrown replay', async () => {
  const { client } = fakeClient({
    scale: async () => ({ processId: 'p-123', status: 'pending' }),
    waitForProcess: async () => {
      throw new Error('Process p-123 did not finish within 180s');
    },
  });

  const plan = planReplay(changeset([{ field: 'cpuMode', before: 'SHARED', after: 'DEDICATED' }]));
  const result = await executeReplay(client, 'proj-1', plan);

  assert.equal(result.steps[0]?.status, 'failed');
  assert.match(result.steps[0]?.error ?? '', /did not finish/);
  assert.equal(result.complete, false);
});

test('formatResidue produces the red-panel sentence for a deleted service', () => {
  const lines = formatResidue([
    {
      service: 'worker',
      field: SERVICE_FIELD,
      before: 'existed',
      after: null,
      verdict: 'CANNOT_UNDO',
      reason: 'whatever',
    },
  ]);

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /Its data is gone\. I cannot undo that\./);
});
