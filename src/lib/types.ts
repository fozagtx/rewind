/**
 * Rewind, core domain contract.
 *
 * Every module codes against these types. Do not redefine them locally.
 *
 * The product thesis: Zerops retains the 10 most recent APPLICATION versions
 * and will roll any of them back. It retains ZERO versions of INFRASTRUCTURE
 * state. Rewind snapshots declarative project state, diffs it, replays the
 * reversal, and names exactly what it could not undo.
 */

/** A single service's declarative configuration, as returned by project export. */
export interface ServiceConfig {
  hostname: string;
  type: string;
  /** SHARED | DEDICATED */
  cpuMode?: string;
  minCpu?: number;
  maxCpu?: number;
  minRam?: number;
  maxRam?: number;
  minDisk?: number;
  maxDisk?: number;
  minContainers?: number;
  maxContainers?: number;
  /** HA | NON_HA, fixed at service creation, NOT changeable. */
  mode?: string;
  /** Env vars as declared. Values are secrets: never log, never render raw. */
  envSecrets?: Record<string, string>;
  env?: Record<string, string>;
  /** Whether a zerops subdomain is enabled (public exposure). */
  subdomainAccess?: boolean;
  /** Arbitrary remaining export fields, preserved verbatim for round-tripping. */
  [key: string]: unknown;
}

/** A full point-in-time capture of declarative project state. */
export interface ProjectSnapshot {
  id: string;
  projectId: string;
  /** ISO 8601. */
  capturedAt: string;
  /** Why this snapshot exists. */
  trigger: SnapshotTrigger;
  /** Object storage key holding the immutable raw export YAML. */
  artifactKey: string;
  /** sha256 of the raw export bytes. Two identical snapshots must hash equal. */
  contentHash: string;
  services: Record<string, ServiceConfig>;
}

/**
 * Why a snapshot exists.
 *
 * `manual` and `cron` are RESTORE POINTS, the states you can go back to.
 * `pre-mutation` and `post-replay` are bookkeeping, written automatically so a
 * reversal is itself reversible. Bookkeeping must never be chosen as a
 * baseline: doing so let a dry run record the drifted state and made the next
 * undo conclude nothing had changed.
 */
export type SnapshotTrigger = 'cron' | 'pre-mutation' | 'manual' | 'post-replay';

/** Triggers that represent a state a human chose to be able to return to. */
export const RESTORE_POINT_TRIGGERS: readonly SnapshotTrigger[] = ['manual', 'cron'];

/**
 * Reversibility classification. This taxonomy IS the product, the kill-switch
 * wedge dies of partial reversal creating false confidence, so honesty about
 * residue is the feature, not a caveat.
 */
export type Verdict =
  /** Writable through a ZCP mutation tool with no restart. */
  | 'REVERSIBLE'
  /** Writable, but the container must restart for it to take effect. */
  | 'REVERSIBLE_WITH_RESTART'
  /** Export-visible but NOT writable back. Must be surfaced, never silently skipped. */
  | 'CANNOT_UNDO';

/** One field-level change between two snapshots. */
export interface ChangeRow {
  service: string;
  field: string;
  /** null means the field/service did not exist in the earlier snapshot. */
  before: unknown;
  /** null means it was deleted. */
  after: unknown;
  /**
   * Absent until `classify` runs, `diff` produces unclassified rows. Every row
   * reaching replay has passed through classifyAll, which always sets it.
   */
  verdict?: Verdict;
  /** Plain-language reason, shown to a human. Required for CANNOT_UNDO. */
  reason?: string;
  /** True when the value is secret and must be redacted in all output. */
  redacted?: boolean;
}

export interface Changeset {
  id: string;
  projectId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  rows: ChangeRow[];
  computedAt: string;
}

/** A single executable reversal step. */
export interface ReplayStep {
  id: string;
  changesetId: string;
  ordinal: number;
  service: string;
  field: string;
  /** Which adapter operation performs the reversal. */
  operation: ReplayOperation;
  /** The value to restore. */
  targetValue: unknown;
  status: ReplayStepStatus;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type ReplayOperation =
  | 'scale'
  | 'setEnv'
  | 'deleteEnv'
  | 'setSubdomain'
  | 'restart'
  | 'recreateService';

export type ReplayStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped_irreversible';

/**
 * The outcome of a replay. `residue` is non-empty whenever anything could not
 * be undone. A clean result MUST NOT be reported while residue exists.
 */
export interface ReplayResult {
  id: string;
  changesetId: string;
  steps: ReplayStep[];
  residue: ChangeRow[];
  /** True only when residue is empty AND every step succeeded. */
  complete: boolean;
  startedAt: string;
  finishedAt?: string;
}

/** Async platform operation handle, Zerops mutations are not instantaneous. */
export interface ProcessHandle {
  processId: string;
  status: 'pending' | 'running' | 'finished' | 'failed';
}

/**
 * The single seam between Rewind and Zerops. All platform uncertainty is
 * isolated here: a wrong endpoint is a one-file fix, not a rewrite.
 */
export interface ZeropsClient {
  /** Full declarative export. Round-trips into project-import. */
  exportProject(projectId: string): Promise<{ raw: string; services: Record<string, ServiceConfig> }>;
  listServices(projectId: string): Promise<string[]>;
  scale(serviceId: string, patch: ScalePatch): Promise<ProcessHandle>;
  setEnv(serviceId: string, key: string, value: string): Promise<ProcessHandle>;
  deleteEnv(serviceId: string, key: string): Promise<ProcessHandle>;
  setSubdomain(serviceId: string, enabled: boolean): Promise<ProcessHandle>;
  restart(serviceId: string): Promise<ProcessHandle>;
  /** Recreate a deleted service from snapshot YAML via project-import. */
  importServices(projectId: string, yaml: string): Promise<ProcessHandle>;
  waitForProcess(processId: string, timeoutMs?: number): Promise<ProcessHandle>;
  resolveServiceId(projectId: string, hostname: string): Promise<string | null>;
}

export interface ScalePatch {
  cpuMode?: string;
  minCpu?: number;
  maxCpu?: number;
  minRam?: number;
  maxRam?: number;
  minDisk?: number;
  maxDisk?: number;
  minContainers?: number;
  maxContainers?: number;
}

/** Fields that are export-visible but provably NOT writable back. */
export const UNWRITABLE_FIELDS: readonly string[] = [
  'mode',
  'corePackage',
  'hostname',
  'type',
];

export class IrreversibleChange extends Error {
  constructor(
    public readonly row: ChangeRow,
    message: string,
  ) {
    super(message);
    this.name = 'IrreversibleChange';
  }
}
