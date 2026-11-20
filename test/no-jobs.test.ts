import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { GateApprovalStore, listUnnotifiedApprovals } from '../src/gate-approval-store.js';
import { FakeEmbedder } from '../src/embedder.js';
import { store } from '../src/memory.js';

// The jobs queue (`004_jobs` and the job API) belongs to @justfortytwo/scheduler.
// Memory neither creates the table nor writes to it.

let dir: string, h: DbHandles;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'ft-nojobs-')); h = openDb(join(dir, 'm.db')); await runMigrations(h.k); });
afterEach(async () => { await h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

const hasJobsTable = (): boolean =>
  h.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get() !== undefined;

describe('memory migrations', () => {
  it('do not create the jobs table or record 004_jobs', () => {
    expect(hasJobsTable()).toBe(false);
    const names = (h.raw.prepare('SELECT name FROM _migration_state').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).not.toContain('004_jobs');
  });
});

describe('store() produces no jobs', () => {
  it('store() embeds the memory in the same write and needs no jobs table', async () => {
    const embedder = new FakeEmbedder();
    const memId = await store(h, embedder, { content: 'hello scheduler' });
    expect(hasJobsTable()).toBe(false);
    const vec = h.raw.prepare('SELECT rowid FROM memory_vec WHERE rowid = ?').get(BigInt(memId)) as { rowid: number } | undefined;
    expect(vec).toBeDefined();
  });
});

describe('staging an approval produces no jobs', () => {
  it('addPending needs no jobs table; the approval waits un-notified in the outbox', async () => {
    const approvalStore = new GateApprovalStore(h);
    await approvalStore.addPending({ tool: 'bash', target: 'ls', payload: {}, tier: 'ask', tool_use_id: 'tu_np_1', session_id: null });
    await approvalStore.addPending({ tool: 'bash', target: 'pwd', payload: {}, tier: 'ask', tool_use_id: 'tu_np_2', session_id: null });
    expect(hasJobsTable()).toBe(false);
    expect(listUnnotifiedApprovals(h)).toHaveLength(2);
  });
});
