#!/usr/bin/env node
/**
 * Rewind CLI.
 *
 *   rewind doctor                 verify the MCP tool surface is reachable
 *   rewind snapshot               capture project state now
 *   rewind diff [--from --to]     show what changed between two snapshots
 *   rewind --to 20m               reverse the last 20 minutes
 *   rewind --to 20m --dry-run     plan the reversal without executing it
 *
 * Requires: ZEROPS_PROJECT_ID, and a reachable `zcp` binary.
 */

import { McpClient } from '../lib/mcp.ts';
import { createZeropsClient } from '../lib/zerops.ts';
import { buildSnapshot } from '../lib/snapshot.ts';
import { diffSnapshots } from '../lib/diff.ts';
import { classifyAll, summarize } from '../lib/classify.ts';
import { executeReplay, formatResidue, planReplay } from '../lib/replay.ts';
import { FileSnapshotStore } from '../lib/store.ts';
import { renderChangeset, renderResidue, renderReplayProgress } from './render.ts';
import { pickBaseline } from '../lib/window.ts';
import type { Changeset } from '../lib/types.ts';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'rewind';

  const projectId = process.env.ZEROPS_PROJECT_ID;
  if (!projectId) {
    console.error('ZEROPS_PROJECT_ID is not set.');
    return 2;
  }

  const store = new FileSnapshotStore(process.env.REWIND_DATA_DIR);
  await store.init();

  const mcp = new McpClient({
    command: process.env.ZCP_COMMAND ?? 'zcp',
    args: (process.env.ZCP_ARGS ?? 'mcp').split(' ').filter(Boolean),
  });

  try {
    await mcp.start();
  } catch (err) {
    console.error(`Could not start the ZCP MCP server: ${(err as Error).message}`);
    console.error('Set ZCP_COMMAND if the binary is named differently.');
    return 3;
  }

  const zerops = createZeropsClient({ mcp });

  try {
    switch (command) {
      case 'doctor':
        return await doctor(zerops, projectId);
      case 'snapshot':
        return await snapshot(zerops, store, projectId);
      case 'diff':
        return await diff(store, projectId, argv);
      case 'rewind':
        return await rewind(zerops, store, projectId, argv);
      default:
        console.error(`Unknown command: ${command}`);
        return 2;
    }
  } finally {
    await mcp.stop();
  }
}

async function doctor(
  zerops: ReturnType<typeof createZeropsClient>,
  projectId: string,
): Promise<number> {
  const tools = await zerops.listAvailableTools();
  const required = [
    'zerops_export',
    'zerops_discover',
    'zerops_scale',
    'zerops_env',
    'zerops_subdomain',
    'zerops_manage',
    'zerops_import',
    'zerops_process',
  ];

  console.log(`${BOLD}MCP tools exposed${RESET} (${tools.length})`);
  for (const t of tools) console.log(`  ${t}`);

  const missing = required.filter((r) => !tools.includes(r));
  console.log('');
  if (missing.length > 0) {
    console.log(`Missing tools Rewind depends on: ${missing.join(', ')}`);
    return 1;
  }
  console.log('All required tools are present.');

  const services = await zerops.listServices(projectId);
  console.log(`Services in project: ${services.join(', ') || '(none found)'}`);
  return 0;
}

async function snapshot(
  zerops: ReturnType<typeof createZeropsClient>,
  store: FileSnapshotStore,
  projectId: string,
): Promise<number> {
  const { raw } = await zerops.exportProject(projectId);
  const artifactKey = store.artifactKey(projectId);
  const snap = buildSnapshot({ projectId, raw, trigger: 'manual', artifactKey });

  await store.putArtifact(artifactKey, raw);
  await store.putSnapshot(snap);

  const count = Object.keys(snap.services).length;
  console.log(`Captured ${count} service${count === 1 ? '' : 's'}  ${DIM}${snap.id}${RESET}`);
  console.log(`${DIM}hash ${snap.contentHash.slice(0, 12)}  ${artifactKey}${RESET}`);
  return 0;
}

async function diff(
  store: FileSnapshotStore,
  projectId: string,
  argv: string[],
): Promise<number> {
  const window = flagValue(argv, '--to') ?? '20m';
  const snaps = await store.listSnapshots(projectId);

  if (snaps.length < 2) {
    console.error(`Need at least 2 snapshots to diff; have ${snaps.length}.`);
    return 1;
  }

  const target = pickBaseline(snaps, window);
  const latest = snaps[snaps.length - 1];
  if (!target || !latest) return 1;

  const rows = classifyAll(diffSnapshots(target, latest));
  console.log(renderChangeset(rows, { from: target, to: latest, window }));
  console.log(renderResidue(summarize(rows).residue));
  return 0;
}

async function rewind(
  zerops: ReturnType<typeof createZeropsClient>,
  store: FileSnapshotStore,
  projectId: string,
  argv: string[],
): Promise<number> {
  const window = flagValue(argv, '--to') ?? '20m';
  const dryRun = argv.includes('--dry-run');

  const snaps = await store.listSnapshots(projectId);
  if (snaps.length < 1) {
    console.error('No snapshots stored. Run `rewind snapshot` first.');
    return 1;
  }

  // Always capture current state before reversing, so the reversal itself is
  // reversible.
  const { raw } = await zerops.exportProject(projectId);
  const nowKey = store.artifactKey(projectId);
  const current = buildSnapshot({
    projectId,
    raw,
    trigger: 'pre-mutation',
    artifactKey: nowKey,
  });
  await store.putArtifact(nowKey, raw);
  await store.putSnapshot(current);

  const baseline = pickBaseline(snaps, window);
  if (!baseline) {
    console.error(`No snapshot found at or before ${window} ago.`);
    return 1;
  }

  const rows = classifyAll(diffSnapshots(baseline, current));
  if (rows.length === 0) {
    console.log('No infrastructure drift detected in that window.');
    return 0;
  }

  const changeset: Changeset = {
    id: `cs-${current.id.slice(0, 8)}`,
    projectId,
    fromSnapshotId: baseline.id,
    toSnapshotId: current.id,
    rows,
    computedAt: new Date().toISOString(),
  };

  console.log(renderChangeset(rows, { from: baseline, to: current, window }));

  const plan = planReplay(changeset, baseline);

  if (dryRun) {
    console.log(`\n${BOLD}Dry run${RESET} — ${plan.steps.length} step(s) planned, nothing executed.`);
    for (const s of plan.steps) {
      console.log(`  ${s.ordinal + 1}. ${s.operation} ${s.service} ${DIM}${s.field}${RESET}`);
    }
    console.log(renderResidue(plan.residue));
    return 0;
  }

  console.log(`\n${BOLD}Replaying ${plan.steps.length} step(s)${RESET}`);
  const result = await executeReplay(zerops, projectId, plan, {
    onStep: (step) => process.stdout.write(renderReplayProgress(step)),
  });

  await store.putSnapshotOf(zerops, projectId, 'post-replay');

  console.log(renderResidue(result.residue));

  if (result.complete) {
    console.log(`\n${BOLD}Rewind complete.${RESET} Everything in that window was reversed.`);
    return 0;
  }

  const failed = result.steps.filter((s) => s.status === 'failed').length;
  console.log(
    `\n${BOLD}Rewind incomplete.${RESET} ` +
      `${result.steps.filter((s) => s.status === 'succeeded').length} reversed, ` +
      `${failed} failed, ${result.residue.length} could not be undone.`,
  );
  // Non-zero: a partial reversal must never look like success to a script.
  return 1;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('-')) return argv[i + 1];
  return undefined;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
