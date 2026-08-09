/**
 * Diff, compute field-level changes between two project snapshots.
 *
 * Output ordering is deterministic so two runs on identical input produce
 * byte-identical changesets. That property is what makes a snapshot chain
 * auditable.
 */

import type { ChangeRow, ProjectSnapshot, ServiceConfig } from './types.ts';
import { isSecretField } from './redact.ts';
import { VOLATILE_KEYS } from './snapshot.ts';

/** Sentinel field name marking service creation or deletion. */
export const SERVICE_FIELD = '__service';

export function diffSnapshots(from: ProjectSnapshot, to: ProjectSnapshot): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const hostnames = new Set([
    ...Object.keys(from.services),
    ...Object.keys(to.services),
  ]);

  for (const hostname of hostnames) {
    const before = from.services[hostname];
    const after = to.services[hostname];

    if (before && !after) {
      // Service deletion, the highest-stakes case in the whole tool.
      rows.push({
        service: hostname,
        field: SERVICE_FIELD,
        before: 'existed',
        after: null,
      });
      continue;
    }

    if (!before && after) {
      rows.push({
        service: hostname,
        field: SERVICE_FIELD,
        before: null,
        after: 'created',
      });
      continue;
    }

    if (!before || !after) continue;

    rows.push(...diffService(hostname, before, after));
  }

  return sortRows(rows);
}

function diffService(
  hostname: string,
  before: ServiceConfig,
  after: ServiceConfig,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (isIgnoredKey(key)) continue;

    // Env buckets are diffed key-by-key, not as opaque objects.
    if (key === 'env' || key === 'envSecrets') continue;

    const b = (before as Record<string, unknown>)[key];
    const a = (after as Record<string, unknown>)[key];

    if (valuesEqual(b, a)) continue;

    rows.push({
      service: hostname,
      field: key,
      before: b ?? null,
      after: a ?? null,
    });
  }

  rows.push(...diffEnvBucket(hostname, 'env', before, after));
  rows.push(...diffEnvBucket(hostname, 'envSecrets', before, after));

  return rows;
}

function diffEnvBucket(
  hostname: string,
  bucket: 'env' | 'envSecrets',
  before: ServiceConfig,
  after: ServiceConfig,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const b = before[bucket] ?? {};
  const a = after[bucket] ?? {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);

  for (const key of keys) {
    const bv = Object.prototype.hasOwnProperty.call(b, key) ? b[key] : undefined;
    const av = Object.prototype.hasOwnProperty.call(a, key) ? a[key] : undefined;

    if (bv === av) continue;

    // A key is secret if either side classifies it as such.
    const secret =
      bucket === 'envSecrets' ||
      isSecretField(before, key) ||
      isSecretField(after, key);

    const row: ChangeRow = {
      service: hostname,
      field: `${bucket}.${key}`,
      before: bv ?? null,
      after: av ?? null,
    };

    if (secret) {
      // Never let the raw value into the row at all.
      row.redacted = true;
      row.before = bv === undefined ? null : '(set)';
      row.after = av === undefined ? null : '(set)';
    }

    rows.push(row);
  }

  return rows;
}

function isIgnoredKey(key: string): boolean {
  return key.startsWith('_') || VOLATILE_KEYS.has(key);
}

/**
 * Numeric-aware equality. `4` and `4.0` and `"4"` are the same scaling value;
 * treating them as a change would produce phantom rows on every snapshot.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;

  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return an === bn;

  if (typeof a === 'object' && typeof b === 'object') {
    return stableStringify(a) === stableStringify(b);
  }

  return String(a) === String(b);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

/** Service, then field. Stable across runs. */
function sortRows(rows: ChangeRow[]): ChangeRow[] {
  return [...rows].sort((x, y) => {
    if (x.service !== y.service) return x.service < y.service ? -1 : 1;
    if (x.field !== y.field) return x.field < y.field ? -1 : 1;
    return 0;
  });
}
