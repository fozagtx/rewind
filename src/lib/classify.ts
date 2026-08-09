/**
 * Classify — decide, per changed field, whether Rewind can actually undo it.
 *
 * This module IS the product. The kill-switch wedge dies of partial reversal
 * creating false confidence, so honesty about residue is the feature and not a
 * caveat. Two rules follow from that:
 *
 *   1. An unrecognised field defaults to CANNOT_UNDO. Never silently claim to
 *      reverse something no known mutation tool writes.
 *   2. Every CANNOT_UNDO row carries a plain-language reason a human reads.
 *
 * Grounded in Zerops docs verified 2026-08-09:
 *   - HA vs NON_HA is fixed at service creation and not changeable.
 *   - corePackage LIGHT->SERIOUS is one-way and partially destructive.
 *   - Application versions roll back; infrastructure state does not.
 */

import type { ChangeRow, Verdict } from './types.ts';
import { UNWRITABLE_FIELDS } from './types.ts';
import { SERVICE_FIELD } from './diff.ts';

/** Fields a scale operation can write. */
export const SCALE_FIELDS: ReadonlySet<string> = new Set([
  'cpuMode',
  'minCpu',
  'maxCpu',
  'minRam',
  'maxRam',
  'minDisk',
  'maxDisk',
  'minContainers',
  'maxContainers',
]);

const REASONS: Record<string, string> = {
  mode: 'HA mode is fixed at service creation and cannot be changed.',
  corePackage:
    'Core package upgrade is one-way and partially destructive (logs and statistics are lost).',
  hostname: 'Hostname cannot be changed after creation.',
  type: 'Service type cannot be changed after creation.',
};

const SERVICE_DELETED_REASON =
  'Service was deleted. Configuration can be restored from snapshot. ' +
  'Its data is gone and cannot be recovered.';

const UNKNOWN_FIELD_REASON =
  'Field is visible in export but no known mutation tool writes it.';

export function classifyRow(row: ChangeRow): ChangeRow {
  const { verdict, reason } = decide(row);
  const out: ChangeRow = { ...row, verdict };
  if (verdict === 'CANNOT_UNDO') {
    out.reason = reason ?? UNKNOWN_FIELD_REASON;
  } else if (reason) {
    out.reason = reason;
  }
  return out;
}

function decide(row: ChangeRow): { verdict: Verdict; reason?: string } {
  const { field } = row;

  if (field === SERVICE_FIELD) {
    if (row.after === null) {
      return { verdict: 'CANNOT_UNDO', reason: SERVICE_DELETED_REASON };
    }
    // Service was added. Reversing means deleting it, which the planner
    // deliberately refuses to automate — but the change itself is reversible.
    return { verdict: 'REVERSIBLE' };
  }

  if (Object.prototype.hasOwnProperty.call(REASONS, field)) {
    return { verdict: 'CANNOT_UNDO', reason: REASONS[field] };
  }

  if (UNWRITABLE_FIELDS.includes(field)) {
    return { verdict: 'CANNOT_UNDO', reason: UNKNOWN_FIELD_REASON };
  }

  if (SCALE_FIELDS.has(field)) {
    return { verdict: 'REVERSIBLE' };
  }

  if (field === 'subdomainAccess') {
    return { verdict: 'REVERSIBLE' };
  }

  if (field.startsWith('env.') || field.startsWith('envSecrets.')) {
    return {
      verdict: 'REVERSIBLE_WITH_RESTART',
      reason: 'Environment changes take effect after the container restarts.',
    };
  }

  return { verdict: 'CANNOT_UNDO', reason: UNKNOWN_FIELD_REASON };
}

export function classifyAll(rows: ChangeRow[]): ChangeRow[] {
  return rows.map(classifyRow);
}

export interface ChangesetSummary {
  reversible: number;
  withRestart: number;
  cannotUndo: number;
  residue: ChangeRow[];
  /** True when nothing in this changeset is irreversible. */
  fullyReversible: boolean;
}

export function summarize(rows: ChangeRow[]): ChangesetSummary {
  const classified = rows.every((r) => r.verdict) ? rows : classifyAll(rows);
  const residue = classified.filter((r) => r.verdict === 'CANNOT_UNDO');

  return {
    reversible: classified.filter((r) => r.verdict === 'REVERSIBLE').length,
    withRestart: classified.filter((r) => r.verdict === 'REVERSIBLE_WITH_RESTART').length,
    cannotUndo: residue.length,
    residue,
    fullyReversible: residue.length === 0,
  };
}
