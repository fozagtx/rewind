/**
 * Rewind HTTP service, read only.
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
import { createRestClient, type RestZeropsClient } from '../lib/rest.ts';
import { FileSnapshotStore } from '../lib/store.ts';
import { diffSnapshots } from '../lib/diff.ts';
import { classifyAll, summarize } from '../lib/classify.ts';
import { pickBaseline } from '../lib/window.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PROJECT_ID =
  process.env.REWIND_PROJECT_ID ?? process.env.ZEROPS_PROJECT_ID ?? '';

const store = new FileSnapshotStore(process.env.REWIND_DATA_DIR);

/**
 * Null until a token is available. The service must still serve health and the
 * stored snapshot chain without one, so this is resolved lazily rather than at
 * import time.
 */
let zerops: RestZeropsClient | null = null;
let apiReady = false;
let apiError = '';

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

  // Health must not depend on the Zerops API being reachable. If it did, an API
  // outage would fail the readiness probe, and Zerops would delete and recreate
  // this container every five minutes in a loop.
  if (route === 'GET /health') {
    json(res, 200, {
      status: 'ok',
      apiReady,
      ...(apiError ? { apiError } : {}),
      projectConfigured: PROJECT_ID !== '',
      mutating: false,
    });
    return;
  }

  // Only the data routes need a project. The landing page must always render,
  // otherwise a missing env var makes the deployment look dead when it is not.
  if (!PROJECT_ID && url.pathname.startsWith('/api/')) {
    json(res, 503, {
      error: 'ZEROPS_PROJECT_ID is not set',
      fix: 'Set it on this service in the Zerops GUI under Environment variables.',
    });
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

    if (!zerops) {
      json(res, 503, {
        error: 'No Zerops token available, so current state cannot be read.',
        detail: apiError,
      });
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
        'Rewind, undo the last twenty minutes of infrastructure.',
        '',
        'Zerops keeps your last 10 application versions.',
        'It keeps zero versions of your infrastructure state.',
        '',
        'GET /health',
        'GET /api/snapshots',
        'GET /api/changeset?window=20m',
        '',
        'This service is read only. Rewinding runs from the CLI:',
        '  ./rewind --to 20m',
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
    zerops = createRestClient();
    apiReady = true;
  } catch (err) {
    // Serve health and stored snapshots even with no token configured.
    apiError = (err as Error).message;
    console.error(`Zerops API unavailable: ${apiError}`);
  }

  server.listen(PORT, () => {
    console.log(`Rewind listening on :${PORT}  apiReady=${apiReady}  read-only`);

    // Zerops injects the generated public hostname. Print it so the live URL is
    // discoverable from the runtime log instead of guessed.
    const subdomain = process.env.zeropsSubdomain ?? process.env.ZEROPS_SUBDOMAIN;
    if (subdomain) console.log(`Public URL: ${subdomain}`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

void start();
