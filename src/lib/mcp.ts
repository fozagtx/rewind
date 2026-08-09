/**
 * Minimal MCP stdio client (JSON-RPC 2.0).
 *
 * Rewind talks to Zerops through the ZCP MCP server rather than raw REST.
 * Two reasons that is the right seam:
 *   1. The ZCP tool surface is documented and stable (tool names verified
 *      against docs.zerops.io/zcp/reference/mcp-operations, 2026-08-09).
 *      The public REST swagger did not resolve, so coding against it would
 *      mean inventing paths.
 *   2. ZCP is the surface an agent actually mutates infrastructure through,
 *      so reversing through the same surface is symmetric by construction.
 *
 * Wire protocol is the MCP standard: `initialize`, then `tools/call`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { scrubText } from './redact.ts';

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(scrubText(message));
    this.name = 'McpError';
  }
}

export interface McpClientOptions {
  /** Command that starts the MCP server. Defaults to the ZCP binary. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-call timeout. Zerops mutations are async; polling is separate. */
  timeoutMs?: number;
}

/**
 * A live stdio MCP session. One process per client instance.
 */
export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly timeoutMs: number;

  constructor(private readonly opts: McpClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const command = this.opts.command ?? 'zcp';
    const args = this.opts.args ?? ['mcp'];

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env },
    });

    proc.on('error', (err) => {
      this.failAll(new McpError(`Failed to start MCP server "${command}": ${err.message}`));
    });

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      if (process.env.REWIND_DEBUG) process.stderr.write(`[mcp] ${scrubText(chunk)}`);
    });

    proc.on('exit', (code) => {
      this.failAll(new McpError(`MCP server exited with code ${code ?? 'null'}`));
      this.proc = null;
    });

    this.proc = proc;

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rewind', version: '0.1.0' },
    });

    this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<string[]> {
    const res = (await this.request('tools/list', {})) as { tools?: Array<{ name: string }> };
    return (res.tools ?? []).map((t) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const res = (await this.request('tools/call', {
      name,
      arguments: args,
    })) as McpToolResult;

    if (res.isError) {
      throw new McpError(`Tool ${name} returned an error: ${extractText(res)}`);
    }
    return res;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdin.end();
    proc.kill('SIGTERM');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // Non-JSON server chatter.
      }

      if (msg.id === undefined) continue; // Notification from server.
      const entry = this.pending.get(msg.id);
      if (!entry) continue;

      clearTimeout(entry.timer);
      this.pending.delete(msg.id);

      if (msg.error) {
        entry.reject(new McpError(msg.error.message, msg.error.code));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new McpError('MCP client not started'));

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(payload + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new McpError(`Failed to write MCP request: ${err.message}`));
        }
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

/** Flatten an MCP tool result's text content blocks. */
export function extractText(res: McpToolResult): string {
  return (res.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}
