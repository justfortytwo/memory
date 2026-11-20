import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { GateApprovalStore, listUnnotifiedApprovals, markApprovalsNotified } from '../src/gate-approval-store.js';

let dir: string;
let h: DbHandles;
let store: GateApprovalStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-appr-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
  store = new GateApprovalStore(h);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

const pending = { tool: 'mcp__messaging__send', target: 'to=x', payload: { to: 'x' }, tier: 'external', tool_use_id: 'tu_1' };

describe('GateApprovalStore', () => {
  it('stages a pending approval and reads it back with provenance', async () => {
    const id = await store.addPending(pending);
    expect(id).toMatch(/^pa_/);
    const row = await store.getByToolUseId('tu_1');
    expect(row?.status).toBe('pending');
    expect(row?.payload).toEqual({ to: 'x' });
  });

  it('markExecuted consumes an approved record exactly once (one-shot)', async () => {
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'approved');
    expect(await store.markExecutedByToolUseId('tu_1')).toBe(true);
    expect(await store.markExecutedByToolUseId('tu_1')).toBe(false);
    expect((await store.getByToolUseId('tu_1'))?.status).toBe('executed');
  });

  it('markExecuted refuses a record that was never approved', async () => {
    await store.addPending(pending);
    expect(await store.markExecutedByToolUseId('tu_1')).toBe(false);
  });

  it('setDecision is fail-closed: cannot resurrect a consumed or denied one-shot', async () => {
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'approved');
    await store.markExecutedByToolUseId('tu_1'); // executed
    expect(await store.setDecisionByToolUseId('tu_1', 'approved')).toBe(false);
    expect((await store.getByToolUseId('tu_1'))?.status).toBe('executed');

    await store.addPending({ ...pending, tool_use_id: 'tu_2' });
    await store.setDecisionByToolUseId('tu_2', 'denied');
    expect(await store.setDecisionByToolUseId('tu_2', 'approved')).toBe(false);
    expect((await store.getByToolUseId('tu_2'))?.status).toBe('denied');
  });

  it('lists staged approvals', async () => {
    await store.addPending(pending);
    await store.addPending({ ...pending, tool_use_id: 'tu_2' });
    expect((await store.list()).map((r) => r.tool_use_id).sort()).toEqual(['tu_1', 'tu_2']);
  });

  it('re-staging a tool_use_id replaces the prior row (one row, most-recent state)', async () => {
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'denied'); // a prior, terminal attempt
    const id2 = await store.addPending(pending);          // re-request approval

    const row = await store.getByToolUseId('tu_1');
    expect(row?.id).toBe(id2);
    expect(row?.status).toBe('pending');                  // fresh, not the stale denied row
    expect(await store.list()).toHaveLength(1);           // not 2
  });

  it('records who decided (decided_by) for the durable audit', async () => {
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'approved', 'cli');
    const r = h.raw.prepare('SELECT decided_by FROM approvals WHERE tool_use_id = ?').get('tu_1');
    expect(r).toMatchObject({ decided_by: 'cli' });
  });

  it('writes an audit entry', async () => {
    await store.log({ actor: 'agent', kind: 'approval_request', content: 'x -> y', approval_status: 'pending', meta: { n: 1 } });
    const rows = h.raw.prepare('SELECT actor, kind, approval_status FROM audit_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'agent', kind: 'approval_request', approval_status: 'pending' });
  });
});

describe('approval notification outbox (notified_at)', () => {
  it('006 adds a nullable notified_at column to approvals', async () => {
    expect(await h.k.schema.hasColumn('approvals', 'notified_at')).toBe(true);
  });

  it('a staged approval is listed until it is stamped, then no longer', async () => {
    const id = await store.addPending(pending);
    expect(listUnnotifiedApprovals(h).map((a) => a.id)).toEqual([id]);
    expect(markApprovalsNotified(h, [id], '2026-11-20T10:00:00.000Z')).toBe(1);
    expect(listUnnotifiedApprovals(h)).toEqual([]);
    const row = h.raw.prepare('SELECT notified_at FROM approvals WHERE id = ?').get(id) as { notified_at: string };
    expect(row.notified_at).toBe('2026-11-20T10:00:00.000Z');
  });

  it('stamping is idempotent: an already-stamped row keeps its first stamp', async () => {
    const id = await store.addPending(pending);
    markApprovalsNotified(h, [id], '2026-11-20T10:00:00.000Z');
    expect(markApprovalsNotified(h, [id], '2026-11-20T11:00:00.000Z')).toBe(0);
    const row = h.raw.prepare('SELECT notified_at FROM approvals WHERE id = ?').get(id) as { notified_at: string };
    expect(row.notified_at).toBe('2026-11-20T10:00:00.000Z');
  });

  it('only pending approvals are listed', async () => {
    await store.addPending(pending);
    await store.setDecisionByToolUseId('tu_1', 'approved');
    expect(listUnnotifiedApprovals(h)).toEqual([]);
  });

  it('re-staging the same tool_use_id resets notified_at to NULL', async () => {
    const first = await store.addPending(pending);
    markApprovalsNotified(h, [first], '2026-11-20T10:00:00.000Z');
    await store.setDecisionByToolUseId('tu_1', 'denied');
    const second = await store.addPending(pending);
    expect(listUnnotifiedApprovals(h).map((a) => a.id)).toEqual([second]);
  });

  it('a row re-staged after it was listed is not stamped by the stale id', async () => {
    const listed = await store.addPending(pending);
    const ids = listUnnotifiedApprovals(h).map((a) => a.id);
    expect(ids).toEqual([listed]);
    const restaged = await store.addPending(pending); // same tool_use_id, new id, while a notify is in flight
    expect(markApprovalsNotified(h, ids, '2026-11-20T10:00:00.000Z')).toBe(0);
    expect(listUnnotifiedApprovals(h).map((a) => a.id)).toEqual([restaged]);
  });

  it('an approval staged while a notify is in flight stays listed for the next poll', async () => {
    await store.addPending(pending);
    const inFlight = listUnnotifiedApprovals(h).map((a) => a.id);
    const late = await store.addPending({ ...pending, tool_use_id: 'tu_late' });
    markApprovalsNotified(h, inFlight, '2026-11-20T10:00:00.000Z');
    expect(listUnnotifiedApprovals(h).map((a) => a.id)).toEqual([late]);
  });
});
