/**
 * Rewind HTTP service — read only.
 *
 * This process never mutates infrastructure. It serves the health check that
 * `zerops.yaml` probes, plus the stored snapshot chain and the current
 * changeset for viewing in a browser.
 *
 * Rewinding is deliberately CLI only. A public subdomain plus a route that
 * reverses live infrastructure is a bad trade, and guarding it would mean
 * inventing a secret for you to manage.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpClient } from '../lib/mcp.ts';
import { createZeropsClient } from '../lib/zerops.ts';
import { FileSnapshotStore } from '../lib/store.ts';
import { diffSnapshots } from '../lib/diff.ts';
import { classifyAll, summarize } from '../lib/classify.ts';
import { pickBaseline } from '../lib/window.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PROJECT_ID = process.env.ZEROPS_PROJECT_ID ?? '';

const store = new FileSnapshotStore(process.env.REWIND_DATA_DIR);
const mcp = new McpClient({
  command: process.env.ZCP_COMMAND ?? 'zcp',
  args: (process.env.ZCP_ARGS ?? 'mcp').split(' ').filter(Boolean),
});
const zerops = createZeropsClient({ mcp });

let mcpReady = false;

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  // Health must not depend on the MCP server being reachable. If it did, a ZCP
  // outage would fail the readiness probe, and Zerops would delete and recreate
  // this container every five minutes in a loop.
  if (route === 'GET /health') {
    json(res, 200, {
      status: 'ok',
      mcpReady,
      projectConfigured: PROJECT_ID !== '',
      mutating: false,
    });
    return;
  }

  if (!PROJECT_ID) {
    json(res, 503, { error: 'ZEROPS_PROJECT_ID is not set' });
    return;
  }

  if (route === 'GET /api/snapshots') {
    const snaps = await store.listSnapshots(PROJECT_ID);
    json(res, 200, {
      count: snaps.length,
      snapshots: snaps.map((s) => ({
        id: s.id,
        capturedAt: s.capturedAt,
        trigger: s.trigger,
        contentHash: s.contentHash,
        services: Object.keys(s.services),
      })),
    });
    return;
  }

  if (route === 'GET /api/changeset') {
    const window = url.searchParams.get('window') ?? '20m';
    const snaps = await store.listSnapshots(PROJECT_ID);

    if (snaps.length === 0) {
      json(res, 409, { error: 'No snapshots stored yet. Run `rewind snapshot`.' });
      return;
    }

    if (!mcpReady) {
      json(res, 503, { error: 'ZCP MCP is unreachable, so current state cannot be read.' });
      return;
    }

    // Reading current state writes a snapshot, which is a record rather than a
    // mutation of your project.
    const current = await store.putSnapshotOf(zerops, PROJECT_ID, 'cron');
    const baseline = pickBaseline(snaps, window);
    if (!baseline) {
      json(res, 409, { error: `No snapshot at or before ${window} ago.` });
      return;
    }

    const rows = classifyAll(diffSnapshots(baseline, current));
    const summary = summarize(rows);

    json(res, 200, {
      window,
      from: { id: baseline.id, capturedAt: baseline.capturedAt },
      to: { id: current.id, capturedAt: current.capturedAt },
      rows,
      summary,
      // The whole point of the tool, in the payload as well as the terminal.
      residue: summary.residue,
      hint:
        summary.residue.length > 0
          ? 'Some changes cannot be undone. Run `rewind --to <window>` to reverse the rest.'
          : 'Everything in this window is reversible. Run `rewind --to <window>`.',
    });
    return;
  }

  if (route === 'GET /') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      [
        'Rewind — undo the last twenty minutes of infrastructure.',
        '',
        'Zerops keeps your last 10 application versions.',
        'It keeps zero versions of your infrastructure state.',
        '',
        'GET /health',
        'GET /api/snapshots',
        'GET /api/changeset?window=20m',
        '',
        'This service is read only. Rewinding runs from the CLI:',
        '  npm run rewind -- --to 20m',
        '',
      ].join('\n'),
    );
    return;
  }

  json(res, 404, { error: `No route for ${route}` });
}

async function start(): Promise<void> {
  await store.init();

  try {
    await mcp.start();
    mcpReady = true;
  } catch (err) {
    // Serve health and stored snapshots even when ZCP is unreachable.
    console.error(`ZCP MCP unavailable: ${(err as Error).message}`);
  }

  server.listen(PORT, () => {
    console.log(`Rewind listening on :${PORT}  mcpReady=${mcpReady}  read-only`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    void mcp.stop().finally(() => process.exit(0));
  });
}

void start();
