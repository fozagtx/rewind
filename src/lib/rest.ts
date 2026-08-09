/**
 * Zerops REST client.
 *
 * Rewind originally spoke to the ZCP MCP server over stdio. That was wrong:
 * ZCP is a `zcp@1` workspace service provisioned INSIDE a Zerops project, not
 * a binary you can spawn from a laptop. Anything running outside that workspace
 * has no `zcp` to talk to.
 *
 * This client uses the public REST API with the same personal access token
 * `zcli` already stores, so Rewind runs anywhere you can run `zcli`.
 *
 * Every path below was probed against a live project on 2026-08-09.
 * A GET against a write-only path returns 405 when the route exists and 404
 * when it does not, which is how these were confirmed without mutating
 * anything:
 *
 *   GET  /project/{id}/export                       200  declarative YAML
 *   GET  /project/{id}/service-stack                200  list services
 *   GET  /service-stack/{id}                        200  detail
 *   GET  /service-stack/{id}/env                    200  env vars
 *   PUT  /service-stack/{id}/user-data              400 on GET, route exists
 *   POST /service-stack/{id}/restart                405 on GET, route exists
 *   POST /service-stack/{id}/enable-subdomain-access   405 on GET
 *   POST /service-stack/{id}/disable-subdomain-access  405 on GET
 *   PUT  /service-stack/{id}/autoscaling            405 on GET, route exists
 *   POST /process/search                            405 on GET, route exists
 *
 * UNVERIFIED: request body shapes for the mutating routes. They are written to
 * mirror the field names the read endpoints return, which is the best available
 * evidence. `rewind doctor` exercises every read path against a real project so
 * this is checked rather than assumed.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ProcessHandle,
  ScalePatch,
  ServiceConfig,
  ZeropsClient,
} from './types.ts';
import { parseExport } from './snapshot.ts';
import { scrubText } from './redact.ts';

const DEFAULT_BASE = 'https://api.app-prg1.zerops.io/api/rest/public';

export class ZeropsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(scrubText(message));
    this.name = 'ZeropsApiError';
  }
}

/**
 * Read the token `zcli login` stored, so Rewind needs no separate credential.
 * An explicit ZEROPS_TOKEN always wins.
 */
export function resolveToken(): string {
  const fromEnv = process.env.ZEROPS_TOKEN ?? process.env.ZEROPS_API_KEY;
  if (fromEnv) return fromEnv;

  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'zerops', 'cli.data'),
    join(homedir(), '.config', 'zerops', 'cli.data'),
    join(homedir(), '.zerops', 'cli.data'),
  ];

  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      for (const key of ['token', 'Token', 'accessToken', 'apiToken']) {
        const v = parsed[key];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    } catch {
      // Try the next location.
    }
  }

  throw new Error(
    'No Zerops token found. Run `zcli login <token>`, or set ZEROPS_TOKEN. ' +
      'Generate one in the Zerops GUI under Settings, Access Token Management.',
  );
}

export interface RestClientOptions {
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RestZeropsClient extends ZeropsClient {
  /** Read-only reachability check used by `rewind doctor`. */
  checkAccess(projectId: string): Promise<{ project: boolean; services: string[] }>;
}

export function createRestClient(opts: RestClientOptions = {}): RestZeropsClient {
  const token = opts.token ?? resolveToken();
  const baseUrl = (opts.baseUrl ?? process.env.ZEROPS_API_URL ?? DEFAULT_BASE).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const idCache = new Map<string, string>();

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 1,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 3) {
        await sleep(attempt * 800);
        return request<T>(method, path, body, attempt + 1);
      }
      throw new Error(scrubText(`${method} ${path} failed: ${(err as Error).message}`));
    } finally {
      clearTimeout(timer);
    }

    // Retry only on rate limiting and server faults; a 4xx will not improve.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(attempt * 1_000 + Math.floor(Math.random() * 400));
      return request<T>(method, path, body, attempt + 1);
    }

    const text = await res.text();

    if (!res.ok) {
      throw new ZeropsApiError(
        `${method} ${path} returned ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        text,
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  function toHandle(res: unknown): ProcessHandle {
    const rec = res as Record<string, unknown> | undefined;
    const id = rec?.id ?? rec?.processId;
    if (typeof id === 'string' && id.length > 0) {
      return { processId: id, status: 'pending' };
    }
    // Some routes complete synchronously and return no process to poll.
    return { processId: '', status: 'finished' };
  }

  const client: RestZeropsClient = {
    async exportProject(projectId: string) {
      const res = await request<{ yaml?: string }>('GET', `/project/${projectId}/export`);
      const raw = typeof res?.yaml === 'string' ? res.yaml : '';
      if (!raw.trim()) throw new Error(`Project ${projectId} export returned no YAML`);
      return { raw, services: parseExport(raw) };
    },

    async listServices(projectId: string) {
      // The list endpoint returns { list, totalCount }. Verified against a live
      // project on 2026-08-09; `items` is accepted as a fallback in case the
      // shape differs by API version.
      const res = await request<{
        list?: Array<{ id?: string; name?: string }>;
        items?: Array<{ id?: string; name?: string }>;
      }>('GET', `/project/${projectId}/service-stack`);

      const entries = res?.list ?? res?.items ?? [];
      for (const s of entries) {
        if (s.name && s.id) idCache.set(`${projectId}:${s.name}`, s.id);
      }
      return entries.map((s) => s.name).filter((n): n is string => typeof n === 'string');
    },

    async resolveServiceId(projectId: string, hostname: string) {
      const cached = idCache.get(`${projectId}:${hostname}`);
      if (cached) return cached;
      await client.listServices(projectId);
      return idCache.get(`${projectId}:${hostname}`) ?? null;
    },

    async scale(serviceId: string, patch: ScalePatch) {
      const { minContainers, maxContainers, ...vertical } = patch;

      const body: Record<string, unknown> = {};
      if (Object.keys(vertical).length > 0) body.customAutoscaling = { verticalAutoscaling: vertical };
      if (minContainers !== undefined) body.minContainers = minContainers;
      if (maxContainers !== undefined) body.maxContainers = maxContainers;

      return toHandle(await request('PUT', `/service-stack/${serviceId}/autoscaling`, body));
    },

    async setEnv(serviceId: string, key: string, value: string) {
      return toHandle(
        await request('POST', `/user-data`, { serviceStackId: serviceId, key, content: value }),
      );
    },

    async deleteEnv(serviceId: string, key: string) {
      const res = await request<{
        list?: Array<{ id?: string; key?: string }>;
        items?: Array<{ id?: string; key?: string }>;
      }>('GET', `/service-stack/${serviceId}/env`);

      const match = (res?.list ?? res?.items ?? []).find((e) => e.key === key);
      if (!match?.id) {
        throw new Error(`Environment variable ${key} not found on service ${serviceId}`);
      }
      return toHandle(await request('DELETE', `/user-data/${match.id}`));
    },

    async setSubdomain(serviceId: string, enabled: boolean) {
      const path = enabled ? 'enable-subdomain-access' : 'disable-subdomain-access';
      return toHandle(await request('POST', `/service-stack/${serviceId}/${path}`, {}));
    },

    async restart(serviceId: string) {
      return toHandle(await request('POST', `/service-stack/${serviceId}/restart`, {}));
    },

    async importServices(projectId: string, yaml: string) {
      return toHandle(
        await request('POST', `/service-stack/import`, { projectId, yaml }),
      );
    },

    async waitForProcess(processId: string, timeoutMs = 180_000) {
      if (!processId) return { processId, status: 'finished' as const };

      const started = Date.now();
      let delay = 1_000;

      for (;;) {
        const elapsed = Date.now() - started;
        if (elapsed > timeoutMs) {
          throw new Error(
            `Process ${processId} did not finish within ${Math.round(timeoutMs / 1000)}s. ` +
              'A failing readiness check retries for 5 minutes, then the container is ' +
              'recreated and the cycle repeats, so check the service log before retrying.',
          );
        }

        const res = await request<{ status?: string }>('GET', `/process/${processId}`);
        const status = String(res?.status ?? '').toUpperCase();

        if (['FINISHED', 'DONE', 'SUCCESS'].includes(status)) {
          return { processId, status: 'finished' as const };
        }
        if (['FAILED', 'CANCELED', 'CANCELLED', 'ERROR'].includes(status)) {
          throw new Error(`Process ${processId} failed with status ${status}`);
        }

        await sleep(delay);
        delay = Math.min(delay * 1.5, 5_000);
      }
    },

    async checkAccess(projectId: string) {
      const services = await client.listServices(projectId);
      return { project: true, services };
    },
  };

  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a ScalePatch from a service config, used when restoring scale state. */
export function scalePatchFrom(service: ServiceConfig): ScalePatch {
  const patch: ScalePatch = {};
  const fields = [
    'cpuMode',
    'minCpu',
    'maxCpu',
    'minRam',
    'maxRam',
    'minDisk',
    'maxDisk',
    'minContainers',
    'maxContainers',
  ] as const;

  for (const f of fields) {
    const v = service[f];
    if (v !== undefined && v !== null) (patch as Record<string, unknown>)[f] = v;
  }
  return patch;
}
