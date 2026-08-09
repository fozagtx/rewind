/**
 * Snapshot store.
 *
 * Local filesystem now; the same interface backs Zerops object storage +
 * Postgres in the deployed service. Artifacts are immutable and content-hashed,
 * so a snapshot chain can be verified after the fact.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectSnapshot, SnapshotTrigger, ZeropsClient } from './types.ts';
import { buildSnapshot } from './snapshot.ts';

export class FileSnapshotStore {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(process.cwd(), '.rewind');
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, 'artifacts'), { recursive: true });
    await mkdir(join(this.root, 'snapshots'), { recursive: true });
  }

  artifactKey(projectId: string): string {
    return `artifacts/${projectId}/${Date.now()}-${randomUUID().slice(0, 8)}.yaml`;
  }

  async putArtifact(key: string, raw: string): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, raw, 'utf8');
  }

  async getArtifact(key: string): Promise<string> {
    return readFile(join(this.root, key), 'utf8');
  }

  async putSnapshot(snap: ProjectSnapshot): Promise<void> {
    const dir = join(this.root, 'snapshots', snap.projectId);
    await mkdir(dir, { recursive: true });
    // Timestamp-prefixed filename keeps the directory listing chronological.
    const name = `${Date.parse(snap.capturedAt)}-${snap.id}.json`;
    await writeFile(join(dir, name), JSON.stringify(snap, null, 2), 'utf8');
  }

  /** All snapshots for a project, oldest first. */
  async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    const dir = join(this.root, 'snapshots', projectId);
    if (!existsSync(dir)) return [];

    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    const out: ProjectSnapshot[] = [];

    for (const f of files) {
      try {
        out.push(JSON.parse(await readFile(join(dir, f), 'utf8')) as ProjectSnapshot);
      } catch {
        // A corrupt snapshot must not break the chain, skip it.
      }
    }

    return out.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  }

  /** Capture and persist current project state in one call. */
  async putSnapshotOf(
    client: ZeropsClient,
    projectId: string,
    trigger: SnapshotTrigger,
  ): Promise<ProjectSnapshot> {
    const { raw } = await client.exportProject(projectId);
    const artifactKey = this.artifactKey(projectId);
    const snap = buildSnapshot({ projectId, raw, trigger, artifactKey });
    await this.putArtifact(artifactKey, raw);
    await this.putSnapshot(snap);
    return snap;
  }
}
