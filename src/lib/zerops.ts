/**
 * Zerops adapter — the single seam between Rewind and the platform.
 *
 * All platform uncertainty is isolated here, so a wrong tool argument is a
 * one-file fix rather than a rewrite.
 *
 * Tool names verified against docs.zerops.io/zcp/reference/mcp-operations
 * (fetched 2026-08-09):
 *   zerops_export     read-only, project/service export YAML + metadata
 *   zerops_discover   read-only, services/ports/env keys/state
 *   zerops_scale      CPU, RAM, disk, CPU mode, autoscaling "where supported";
 *                     explicitly CANNOT change HA/NON_HA (set at creation)
 *   zerops_env        read, set, delete, generate env vars
 *   zerops_subdomain  enable/disable public subdomain access
 *   zerops_manage     start, stop, restart, reload, connect storage
 *   zerops_import     import project/service definitions; destructive
 *                     override is gated (first call refused, second must
 *                     acknowledge the same targets)
 *   zerops_process    check a known async process
 *
 * UNVERIFIED: the exact ARGUMENT NAMES per tool are not published on the
 * operations page — only names, purposes, and mutation scope. The public REST
 * swagger returned 404, so REST paths would have to be invented; the MCP
 * surface is the documented one. `listAvailableTools` reads the live
 * `tools/list` schema so naming is discovered rather than guessed. Run
 * `npm run rewind -- doctor` against a real project before demoing.
 */

import type {
  ProcessHandle,
  ScalePatch,
  ServiceConfig,
  ZeropsClient,
} from './types.ts';
import { McpClient, extractText, type McpToolResult } from './mcp.ts';
import { parseExport } from './snapshot.ts';
import { scrubText } from './redact.ts';

export interface ZeropsClientOptions {
  mcp: McpClient;
  /** Poll ceiling for async platform operations. */
  processTimeoutMs?: number;
}

export interface ExtendedZeropsClient extends ZeropsClient {
  listAvailableTools(): Promise<string[]>;
}

export function createZeropsClient(opts: ZeropsClientOptions): ExtendedZeropsClient {
  const { mcp } = opts;
  const processTimeoutMs = opts.processTimeoutMs ?? 180_000;
  const serviceIdCache = new Map<string, string>();

  async function call(tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    try {
      return await mcp.callTool(tool, args);
    } catch (err) {
      throw new Error(
        scrubText(`${tool} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  /** Pull a process handle out of whatever shape the tool returned. */
  function toProcessHandle(res: McpToolResult): ProcessHandle {
    const structured = res.structuredContent as Record<string, unknown> | undefined;
    const fromStructured =
      structured && (structured.processId ?? structured.process_id ?? structured.id);
    if (typeof fromStructured === 'string' && fromStructured.length > 0) {
      return { processId: fromStructured, status: 'pending' };
    }

    const text = extractText(res);
    const match = text.match(/\b(?:process|processId|process_id)\W{0,3}([A-Za-z0-9_-]{6,})/i);
    if (match?.[1]) return { processId: match[1], status: 'pending' };

    // Synchronous completion — nothing to poll.
    return { processId: '', status: 'finished' };
  }

  const client: ExtendedZeropsClient = {
    async exportProject(projectId: string) {
      const res = await call('zerops_export', { projectId });
      const raw = extractText(res);
      if (!raw.trim()) throw new Error('zerops_export returned no content');
      return { raw, services: parseExport(raw) };
    },

    async listServices(projectId: string) {
      const res = await call('zerops_discover', { projectId });
      const structured = res.structuredContent as
        | { services?: Array<{ hostname?: string; id?: string }> }
        | undefined;

      if (structured?.services) {
        for (const s of structured.services) {
          if (s.hostname && s.id) serviceIdCache.set(`${projectId}:${s.hostname}`, s.id);
        }
        return structured.services.map((s) => s.hostname).filter(isString);
      }

      const text = extractText(res);
      return [...text.matchAll(/^\s*[-*]?\s*hostname:\s*([A-Za-z0-9-]+)/gim)]
        .map((m) => m[1])
        .filter(isString);
    },

    async resolveServiceId(projectId: string, hostname: string) {
      const key = `${projectId}:${hostname}`;
      const cached = serviceIdCache.get(key);
      if (cached) return cached;
      await client.listServices(projectId);
      return serviceIdCache.get(key) ?? null;
    },

    async scale(serviceId: string, patch: ScalePatch) {
      // zerops_scale writes CPU/RAM/disk/cpuMode/autoscaling. It cannot write
      // HA mode; the classifier marks that CANNOT_UNDO upstream.
      const res = await call('zerops_scale', { service: serviceId, ...patch });
      return toProcessHandle(res);
    },

    async setEnv(serviceId: string, key: string, value: string) {
      const res = await call('zerops_env', {
        action: 'set',
        service: serviceId,
        key,
        value,
      });
      return toProcessHandle(res);
    },

    async deleteEnv(serviceId: string, key: string) {
      const res = await call('zerops_env', { action: 'delete', service: serviceId, key });
      return toProcessHandle(res);
    },

    async setSubdomain(serviceId: string, enabled: boolean) {
      const res = await call('zerops_subdomain', {
        action: enabled ? 'enable' : 'disable',
        service: serviceId,
      });
      return toProcessHandle(res);
    },

    async restart(serviceId: string) {
      const res = await call('zerops_manage', { action: 'restart', service: serviceId });
      return toProcessHandle(res);
    },

    async importServices(projectId: string, yaml: string) {
      // Recreating a deleted service. Destructive override is gated by ZCP
      // itself; we never pass an override flag, so nothing is clobbered.
      const res = await call('zerops_import', { projectId, yaml });
      return toProcessHandle(res);
    },

    async waitForProcess(processId: string, timeoutMs = processTimeoutMs) {
      if (!processId) return { processId, status: 'finished' as const };

      const started = Date.now();
      let delay = 1_000;

      for (;;) {
        const elapsed = Date.now() - started;
        if (elapsed > timeoutMs) {
          throw new Error(
            `Process ${processId} did not finish within ${Math.round(timeoutMs / 1000)}s ` +
              `(waited ${Math.round(elapsed / 1000)}s). A failing readiness check retries ` +
              `for 5 minutes, then the container is recreated and the cycle repeats — ` +
              `check zerops_events before retrying.`,
          );
        }

        const res = await call('zerops_process', { processId });
        const status = readStatus(res);

        if (status === 'finished') return { processId, status };
        if (status === 'failed') {
          throw new Error(`Process ${processId} failed: ${scrubText(extractText(res))}`);
        }

        await sleep(delay);
        delay = Math.min(delay * 1.5, 5_000);
      }
    },

    async listAvailableTools() {
      return mcp.listTools();
    },
  };

  return client;
}

function readStatus(res: McpToolResult): ProcessHandle['status'] {
  const structured = res.structuredContent as Record<string, unknown> | undefined;
  const raw =
    (typeof structured?.status === 'string' ? structured.status : undefined) ??
    extractText(res);
  const s = raw.toLowerCase();

  if (/\b(finished|done|success|succeeded|completed)\b/.test(s)) return 'finished';
  if (/\b(failed|error|cancell?ed)\b/.test(s)) return 'failed';
  if (/\brunning\b/.test(s)) return 'running';
  return 'pending';
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build a ScalePatch from a service config — used when restoring scale state. */
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
