/**
 * Replay, plan and execute the inverse of a changeset.
 *
 * The core discipline, and the reason this file is worth reading:
 * `complete` is true ONLY when residue is empty AND every step succeeded.
 * A kill switch that reports a clean reversal while something remains
 * un-undone is worse than no kill switch, because it manufactures false
 * confidence. Rewind would rather say "I could not fix this" than be wrong.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChangeRow,
  Changeset,
  ProjectSnapshot,
  ReplayOperation,
  ReplayResult,
  ReplayStep,
  ScalePatch,
  ZeropsClient,
} from './types.ts';
import { SCALE_FIELDS } from './classify.ts';
import { SERVICE_FIELD } from './diff.ts';
import { serviceToImportYaml } from './snapshot.ts';

export interface ReplayPlan {
  steps: ReplayStep[];
  residue: ChangeRow[];
}

/** Execution order. A service must exist before its env can be set. */
const OPERATION_ORDER: Record<ReplayOperation, number> = {
  recreateService: 0,
  scale: 1,
  setEnv: 2,
  deleteEnv: 2,
  setSubdomain: 3,
  restart: 4,
};

const SERVICE_ADDED_RESIDUE_REASON =
  'Service was created during this window. Reversing means deleting it, which ' +
  'Rewind never does automatically. Delete it yourself if that is what you want.';

/**
 * Reported even when the configuration was successfully recreated. Restoring a
 * database service's config does not restore its rows, and a tool that stayed
 * quiet about that would be lying by omission.
 */
const DATA_LOSS_REASON =
  'Configuration restored from snapshot. The data it held is gone, deleting a ' +
  'service destroys its volume, and no export contains it.';

/**
 * Build the reversal plan. `targetValue` is always the row's `before` value ,
 * we are restoring the earlier state, not re-applying the change.
 */
export function planReplay(
  changeset: Changeset,
  fromSnapshot?: ProjectSnapshot,
): ReplayPlan {
  const residue: ChangeRow[] = [];
  const steps: ReplayStep[] = [];

  // Scale fields are coalesced per service: nine separate scale calls for one
  // service is both wrong and slow.
  const scalePatches = new Map<string, ScalePatch>();
  const needsRestart = new Set<string>();

  for (const row of changeset.rows) {
    // Service deletion is handled BEFORE the CANNOT_UNDO check, because it is
    // the one case that is partially reversible: the configuration can be
    // recreated from snapshot, and the data cannot. Rewind does both halves ,
    // it restores what it can and reports what it could not. Checking the
    // verdict first would make the recreate path unreachable.
    if (row.field === SERVICE_FIELD && row.after === null) {
      const svc = fromSnapshot?.services[row.service];

      if (!svc) {
        residue.push({
          ...row,
          verdict: 'CANNOT_UNDO',
          reason:
            'Service was deleted and no snapshot of its configuration is available to restore from.',
        });
        continue;
      }

      steps.push(makeStep(changeset.id, row, 'recreateService', serviceToImportYaml(svc)));
      // The data loss is residue even though the config was restored. This is
      // the red panel, and it is the whole point of the tool.
      residue.push({
        ...row,
        verdict: 'CANNOT_UNDO',
        reason: DATA_LOSS_REASON,
      });
      continue;
    }

    if (row.verdict === 'CANNOT_UNDO') {
      residue.push(row);
      continue;
    }

    if (row.field === SERVICE_FIELD) {
      // Service was created during the window. Reversing means deleting it.
      residue.push({ ...row, verdict: 'CANNOT_UNDO', reason: SERVICE_ADDED_RESIDUE_REASON });
      continue;
    }

    if (SCALE_FIELDS.has(row.field)) {
      const patch = scalePatches.get(row.service) ?? {};
      (patch as Record<string, unknown>)[row.field] = row.before;
      scalePatches.set(row.service, patch);
      continue;
    }

    if (row.field === 'subdomainAccess') {
      steps.push(makeStep(changeset.id, row, 'setSubdomain', row.before === true));
      continue;
    }

    if (row.field.startsWith('env.') || row.field.startsWith('envSecrets.')) {
      const key = row.field.slice(row.field.indexOf('.') + 1);
      needsRestart.add(row.service);

      if (row.before === null || row.before === undefined) {
        // The var was ADDED during the window, so reversal deletes it.
        steps.push(makeStep(changeset.id, row, 'deleteEnv', key));
      } else if (row.redacted) {
        // We hold no plaintext for secrets, by design. Cannot restore a value
        // we deliberately never captured.
        residue.push({
          ...row,
          verdict: 'CANNOT_UNDO',
          reason:
            `Secret ${key} changed. Rewind never stores secret values, so it cannot ` +
            `restore the previous one. Reset it from your own secret store.`,
        });
        needsRestart.delete(row.service);
      } else {
        steps.push(makeStep(changeset.id, row, 'setEnv', { key, value: String(row.before) }));
      }
      continue;
    }

    // Reachable only if a verdict says reversible but no handler exists.
    residue.push({
      ...row,
      verdict: 'CANNOT_UNDO',
      reason: `No reversal operation is implemented for field "${row.field}".`,
    });
  }

  for (const [service, patch] of scalePatches) {
    steps.push({
      id: randomUUID(),
      changesetId: changeset.id,
      ordinal: 0,
      service,
      field: Object.keys(patch).sort().join(','),
      operation: 'scale',
      targetValue: patch,
      status: 'pending',
    });
  }

  for (const service of needsRestart) {
    steps.push({
      id: randomUUID(),
      changesetId: changeset.id,
      ordinal: 0,
      service,
      field: '__restart',
      operation: 'restart',
      targetValue: null,
      status: 'pending',
    });
  }

  const ordered = steps
    .sort((a, b) => {
      const byOp = OPERATION_ORDER[a.operation] - OPERATION_ORDER[b.operation];
      if (byOp !== 0) return byOp;
      if (a.service !== b.service) return a.service < b.service ? -1 : 1;
      return a.field < b.field ? -1 : a.field > b.field ? 1 : 0;
    })
    .map((s, i) => ({ ...s, ordinal: i }));

  return { steps: ordered, residue };
}

function makeStep(
  changesetId: string,
  row: ChangeRow,
  operation: ReplayOperation,
  targetValue: unknown,
): ReplayStep {
  return {
    id: randomUUID(),
    changesetId,
    ordinal: 0,
    service: row.service,
    field: row.field,
    operation,
    targetValue,
    status: 'pending',
  };
}

export interface ExecuteOptions {
  onStep?: (step: ReplayStep) => void;
  dryRun?: boolean;
  maxConcurrency?: number;
}

/**
 * Execute the plan. Steps for one service run in order; different services
 * proceed concurrently. A failed step never aborts its siblings, partial
 * progress must stay visible and resumable.
 */
export async function executeReplay(
  client: ZeropsClient,
  projectId: string,
  plan: ReplayPlan,
  opts: ExecuteOptions = {},
): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const steps = plan.steps.map((s) => ({ ...s }));

  if (opts.dryRun) {
    // Report honestly: nothing ran, so nothing is marked as having run.
    return {
      id: randomUUID(),
      changesetId: plan.steps[0]?.changesetId ?? '',
      steps,
      residue: plan.residue,
      complete: false,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const byService = new Map<string, ReplayStep[]>();
  for (const step of steps) {
    const list = byService.get(step.service) ?? [];
    list.push(step);
    byService.set(step.service, list);
  }

  const queue = [...byService.values()];
  const limit = Math.max(1, opts.maxConcurrency ?? 3);

  async function worker(): Promise<void> {
    for (;;) {
      const group = queue.shift();
      if (!group) return;
      for (const step of group) {
        await runStep(client, projectId, step, opts.onStep);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));

  const allSucceeded = steps.every((s) => s.status === 'succeeded');

  return {
    id: randomUUID(),
    changesetId: plan.steps[0]?.changesetId ?? '',
    steps,
    residue: plan.residue,
    // The whole product in one line.
    complete: plan.residue.length === 0 && allSucceeded,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

async function runStep(
  client: ZeropsClient,
  projectId: string,
  step: ReplayStep,
  onStep?: (s: ReplayStep) => void,
): Promise<void> {
  step.status = 'running';
  step.startedAt = new Date().toISOString();
  onStep?.({ ...step });

  try {
    const serviceId =
      step.operation === 'recreateService'
        ? projectId
        : (await client.resolveServiceId(projectId, step.service)) ?? step.service;

    const handle = await dispatch(client, projectId, serviceId, step);
    if (handle.processId) await client.waitForProcess(handle.processId);

    step.status = 'succeeded';
  } catch (err) {
    step.status = 'failed';
    step.error = err instanceof Error ? err.message : String(err);
  } finally {
    step.finishedAt = new Date().toISOString();
    onStep?.({ ...step });
  }
}

function dispatch(
  client: ZeropsClient,
  projectId: string,
  serviceId: string,
  step: ReplayStep,
) {
  switch (step.operation) {
    case 'scale':
      return client.scale(serviceId, step.targetValue as ScalePatch);
    case 'setEnv': {
      const { key, value } = step.targetValue as { key: string; value: string };
      return client.setEnv(serviceId, key, value);
    }
    case 'deleteEnv':
      return client.deleteEnv(serviceId, step.targetValue as string);
    case 'setSubdomain':
      return client.setSubdomain(serviceId, step.targetValue === true);
    case 'restart':
      return client.restart(serviceId);
    case 'recreateService':
      return client.importServices(projectId, step.targetValue as string);
  }
}

/** One plain sentence per residue row, for the red panel. */
export function formatResidue(residue: ChangeRow[]): string[] {
  return residue.map((row) => {
    if (row.field === SERVICE_FIELD && row.after === null) {
      return `Service \`${row.service}\` was deleted. Configuration restored from snapshot. Its data is gone. I cannot undo that.`;
    }
    const reason = row.reason ?? 'No known mutation tool writes this field.';
    return `\`${row.service}\` · ${row.field}: ${reason}`;
  });
}
