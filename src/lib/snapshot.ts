/**
 * Snapshot, capture declarative Zerops project state as an immutable artifact.
 *
 * Zerops project export "matches the import structure and feeds straight back
 * into" import, so the export -> mutate -> export -> replay loop uses a
 * supported round-trip format rather than a scrape.
 */

import { createHash, randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ProjectSnapshot, ServiceConfig, SnapshotTrigger } from './types.ts';

/**
 * Parse project-export YAML into services keyed by hostname.
 *
 * Handles both observed document shapes:
 *   services: [ { hostname: api, ... } ]
 *   project: {...}
 *   services: [ ... ]
 *
 * Unknown fields are preserved verbatim on the index signature, they are
 * needed to recreate a deleted service faithfully.
 */
export function parseExport(raw: string): Record<string, ServiceConfig> {
  if (!raw || raw.trim().length === 0) return {};

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse project export YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const services = extractServiceList(doc);
  const out: Record<string, ServiceConfig> = {};

  for (const entry of services) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const hostname = typeof rec.hostname === 'string' ? rec.hostname : undefined;
    if (!hostname) continue;
    out[hostname] = normalizeService(rec, hostname);
  }

  return out;
}

function extractServiceList(doc: unknown): unknown[] {
  if (!doc || typeof doc !== 'object') return [];
  const rec = doc as Record<string, unknown>;

  if (Array.isArray(rec.services)) return rec.services;

  // Some exports nest under `project`.
  if (rec.project && typeof rec.project === 'object') {
    const proj = rec.project as Record<string, unknown>;
    if (Array.isArray(proj.services)) return proj.services;
  }

  // A single bare service document.
  if (typeof rec.hostname === 'string') return [rec];

  return [];
}

/**
 * Raw export spellings for env data. These are folded into the canonical
 * `env` / `envSecrets` buckets and then REMOVED from the service config.
 *
 * Leaving them in place was a real leak: the generic field-diff walks every
 * remaining key, so a surviving `secretEnvVariables` produced a second,
 * un-redacted row carrying the plaintext secret next to the redacted one.
 */
const RAW_ENV_KEYS = [
  'envVariables',
  'env',
  'envVars',
  'secretEnvVariables',
  'envSecrets',
] as const;

/**
 * Scale fields live nested under `verticalAutoscaling` in project export, and
 * under `customAutoscaling.verticalAutoscaling` in the service API. Flatten
 * both onto the service so the diff produces one row per field.
 *
 * Verified against a live project on 2026-08-09: leaving them nested made the
 * classifier treat every scale change as an unknown field, which meant a
 * routine scale-up was reported as impossible to undo. The whole tool hinges on
 * that verdict, so it has to be right.
 */
const SCALE_FIELD_NAMES = [
  'cpuMode',
  'minCpu',
  'maxCpu',
  'minRam',
  'maxRam',
  'minDisk',
  'maxDisk',
] as const;

function flattenScale(svc: ServiceConfig, rec: Record<string, unknown>): void {
  const nested =
    asRecord(rec.verticalAutoscaling) ??
    asRecord(asRecord(rec.customAutoscaling)?.verticalAutoscaling);

  if (nested) {
    for (const field of SCALE_FIELD_NAMES) {
      const v = nested[field];
      if (v !== undefined && v !== null) (svc as Record<string, unknown>)[field] = v;
    }
  }

  // Remove the containers so no un-flattened copy is left for the generic diff
  // to walk as an opaque object.
  delete (svc as Record<string, unknown>).verticalAutoscaling;
  delete (svc as Record<string, unknown>).customAutoscaling;
  delete (svc as Record<string, unknown>).currentAutoscaling;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function normalizeService(rec: Record<string, unknown>, hostname: string): ServiceConfig {
  const svc: ServiceConfig = { hostname, type: '' };

  for (const [k, v] of Object.entries(rec)) {
    (svc as Record<string, unknown>)[k] = v;
  }

  svc.hostname = hostname;
  svc.type = typeof rec.type === 'string' ? rec.type : '';

  // Zerops expresses env in several spellings depending on export version.
  // Fold them into the two canonical buckets so diffing is stable.
  const env = coerceRecord(rec.envVariables) ?? coerceRecord(rec.env) ?? coerceRecord(rec.envVars);
  const secrets = coerceRecord(rec.secretEnvVariables) ?? coerceRecord(rec.envSecrets);

  // Drop every raw spelling before assigning the canonical buckets, so no
  // plaintext copy is left for the generic diff to walk.
  for (const key of RAW_ENV_KEYS) {
    delete (svc as Record<string, unknown>)[key];
  }

  if (env) svc.env = env;
  if (secrets) svc.envSecrets = secrets;

  flattenScale(svc, rec);

  const subdomain = rec.enableSubdomainAccess ?? rec.subdomainAccess;
  if (typeof subdomain === 'boolean') svc.subdomainAccess = subdomain;

  return svc;
}

function coerceRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = val === null || val === undefined ? '' : String(val);
  }
  return out;
}

/** sha256 hex of the raw export bytes. Identical input always hashes equal. */
export function hashContent(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Build an immutable snapshot record. Pure and deterministic given all args. */
export function buildSnapshot(args: {
  projectId: string;
  raw: string;
  trigger: SnapshotTrigger;
  artifactKey: string;
  id?: string;
  capturedAt?: string;
}): ProjectSnapshot {
  return {
    id: args.id ?? randomUUID(),
    projectId: args.projectId,
    capturedAt: args.capturedAt ?? new Date().toISOString(),
    trigger: args.trigger,
    artifactKey: args.artifactKey,
    contentHash: hashContent(args.raw),
    services: parseExport(args.raw),
  };
}

/**
 * Serialize one service back to import-compatible YAML.
 *
 * Used to recreate a service the agent deleted. Round-trips through
 * parseExport for the fields present.
 */
export function serviceToImportYaml(service: ServiceConfig): string {
  const clean: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(service)) {
    if (v === undefined) continue;
    if (k.startsWith('_')) continue;
    if (VOLATILE_KEYS.has(k)) continue;
    clean[k] = v;
  }

  return stringifyYaml({ services: [clean] }, { lineWidth: 0 });
}

/** Runtime state that is not user-set configuration and must never be diffed. */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'createdAt',
  'lastUpdate',
  'status',
  'state',
  'projectId',
  'clientId',
  'serviceStackTypeVersionId',
]);
