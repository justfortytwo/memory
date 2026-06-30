import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { enqueue, claimDue, complete, fail, listActive, requeueStale, existsPending, countPendingApprovals, setRecurrence } from '../src/jobs.js';
import { GateApprovalStore } from '../src/gate-approval-store.js';
import { FakeEmbedder } from '../src/embedder.js';
import { store } from '../src/memory.js';

let dir: string, h: DbHandles;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'ft-jobs-')); h = openDb(join(dir, 'm.db')); await runMigrations(h.k); });
afterEach(async () => { await h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('004_jobs migration', () => {
  it('creates the jobs table', async () => {
    expect(await h.k.schema.hasTable('jobs')).toBe(true);
  });
});

describe('JobStore', () => {
  it('enqueue + claimDue returns due pending rows and flips them to running', () => {
    enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    const future = enqueue(h, { kind: 'reminder', run_at: '2999-01-01T00:00:00Z' });
    const claimed = claimDue(h, '2026-06-29T00:00:00Z');
    expect(claimed.map((j) => j.kind)).toEqual(['reminder']);          // only the due one
    expect(claimed[0]!.status).toBe('running');
    expect(claimDue(h, '2026-06-29T00:00:00Z')).toEqual([]);            // already claimed → none
    expect(future).toBeGreaterThan(0);
  });

  it('complete with reschedule sets a recurring row back to pending at the new run_at', () => {
    const id = enqueue(h, { kind: 'sweep', run_at: '2020-01-01T00:00:00Z', recurrence: '0 13 * * *' });
    claimDue(h, '2026-06-29T00:00:00Z');
    complete(h, id, { reschedule: '2026-06-30T13:00:00Z' });
    const row = listActive(h).find((j) => j.id === id)!;
    expect(row.status).toBe('pending');
    expect(row.run_at).toBe('2026-06-30T13:00:00Z');
  });

  it('fail increments attempts; marks failed at the cap', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    claimDue(h, '2026-06-29T00:00:00Z');
    fail(h, id, 'boom', { retryAt: '2026-06-29T00:05:00Z' });          // attempt 1 → pending
    const after1 = claimDue(h, '2026-06-29T01:00:00Z')[0]!;
    expect(after1.attempts).toBe(1); expect(after1.status).toBe('running');
    fail(h, id, 'boom', {}); fail(h, id, 'boom', {});                  // reach cap (3) → failed
    expect(listActive(h).find((j) => j.id === id)).toBeUndefined();
  });

  it('requeueStale returns stale running rows to pending', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    claimDue(h, '2026-06-29T00:00:00Z');
    requeueStale(h, '2999-01-01T00:00:00Z');                           // threshold far future → everything stale
    expect(claimDue(h, '2026-06-29T02:00:00Z').map((j) => j.id)).toContain(id);
  });
});

describe('existsPending (exact json_extract match)', () => {
  it('matches the exact payload id and not a different one', () => {
    enqueue(h, { kind: 'reembed_memory', run_at: '2020-01-01T00:00:00Z', payload: { id: 5 } });
    expect(existsPending(h, 'reembed_memory', 5)).toBe(true);
    expect(existsPending(h, 'reembed_memory', 6)).toBe(false);
  });

  it('does NOT collide on substring ids (id 11 must not match a query for 1)', () => {
    enqueue(h, { kind: 'reembed_memory', run_at: '2020-01-01T00:00:00Z', payload: { id: 11 } });
    // Would FAIL under the old `payload LIKE '%"id":1%'` substring match.
    expect(existsPending(h, 'reembed_memory', 1)).toBe(false);
    expect(existsPending(h, 'reembed_memory', 11)).toBe(true);
  });

  it('scopes by kind and ignores terminal (done/failed) jobs', () => {
    const id = enqueue(h, { kind: 'reembed_memory', run_at: '2020-01-01T00:00:00Z', payload: { id: 7 } });
    expect(existsPending(h, 'other_kind', 7)).toBe(false); // wrong kind
    complete(h, id);                                       // → done (terminal)
    expect(existsPending(h, 'reembed_memory', 7)).toBe(false);
  });
});

describe('reembed_memory producer', () => {
  it('store() enqueues exactly one pending reembed_memory job carrying the memory id', async () => {
    const embedder = new FakeEmbedder();
    const memId = await store(h, embedder, { content: 'hello scheduler' });
    const jobs = listActive(h).filter((j) => j.kind === 'reembed_memory');
    expect(jobs).toHaveLength(1);
    const payload = JSON.parse(jobs[0]!.payload ?? '{}') as { id: unknown };
    expect(payload.id).toBe(memId);
  });

  it('a second store() for a different memory creates a second job', async () => {
    const embedder = new FakeEmbedder();
    await store(h, embedder, { content: 'first' });
    await store(h, embedder, { content: 'second' });
    const jobs = listActive(h).filter((j) => j.kind === 'reembed_memory');
    expect(jobs).toHaveLength(2);
  });

  it('store() dedupes: a pre-existing pending reembed for that id blocks a second enqueue', async () => {
    const embedder = new FakeEmbedder();
    // The next memory row will be id 1 (fresh db). Pre-seed its reembed job.
    enqueue(h, { kind: 'reembed_memory', run_at: '2020-01-01T00:00:00Z', payload: { id: 1 } });
    const memId = await store(h, embedder, { content: 'dedupe me' });
    expect(memId).toBe(1);
    const pending = listActive(h).filter(
      (j) => j.kind === 'reembed_memory' && (JSON.parse(j.payload ?? '{}') as { id: unknown }).id === memId,
    );
    expect(pending).toHaveLength(1); // not duplicated by store()
  });
});

describe('countPendingApprovals', () => {
  it('returns 0 when no approvals exist', () => {
    expect(countPendingApprovals(h)).toBe(0);
  });

  it('counts only pending approvals', async () => {
    const approvalStore = new GateApprovalStore(h);
    await approvalStore.addPending({ tool: 'bash', target: 'ls', payload: {}, tier: 'ask', tool_use_id: 'tu_1', session_id: null });
    await approvalStore.addPending({ tool: 'bash', target: 'pwd', payload: {}, tier: 'ask', tool_use_id: 'tu_2', session_id: null });
    expect(countPendingApprovals(h)).toBe(2);
    // approve one → should drop from pending count
    await approvalStore.setDecisionByToolUseId('tu_1', 'approved');
    expect(countPendingApprovals(h)).toBe(1);
  });
});

describe('setRecurrence', () => {
  it('updates recurrence and run_at on an existing job', () => {
    const id = enqueue(h, { kind: 'sweep', run_at: '2026-06-30T13:03:00Z', recurrence: '3 13 * * *' });
    setRecurrence(h, id, '3 13,18 * * *', '2026-06-30T18:03:00Z');
    const row = listActive(h).find((j) => j.id === id)!;
    expect(row.recurrence).toBe('3 13,18 * * *');
    expect(row.run_at).toBe('2026-06-30T18:03:00Z');
  });

  it('updated_at is bumped after setRecurrence', () => {
    const before = new Date().toISOString();
    const id = enqueue(h, { kind: 'sweep', run_at: '2026-06-30T13:03:00Z', recurrence: '3 13 * * *' });
    setRecurrence(h, id, '3 13,18 * * *', '2026-06-30T18:03:00Z');
    const row = listActive(h).find((j) => j.id === id)!;
    expect(row.updated_at >= before).toBe(true);
  });
});
