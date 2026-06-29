import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { enqueue, claimDue, complete, fail, listRecurring, requeueStale } from '../src/jobs.js';

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
    const row = listRecurring(h).find((j) => j.id === id)!;
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
    expect(listRecurring(h).find((j) => j.id === id)).toBeUndefined();
  });

  it('requeueStale returns stale running rows to pending', () => {
    const id = enqueue(h, { kind: 'reminder', run_at: '2020-01-01T00:00:00Z' });
    claimDue(h, '2026-06-29T00:00:00Z');
    requeueStale(h, '2999-01-01T00:00:00Z');                           // threshold far future → everything stale
    expect(claimDue(h, '2026-06-29T02:00:00Z').map((j) => j.id)).toContain(id);
  });
});
