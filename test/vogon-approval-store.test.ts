import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { VogonApprovalStore } from '../src/vogon-approval-store.js';

let dir: string;
let h: DbHandles;
let store: VogonApprovalStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-appr-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
  store = new VogonApprovalStore(h);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

const pending = { tool: 'mcp__messaging__send', target: 'to=x', payload: { to: 'x' }, tier: 'external', tool_use_id: 'tu_1' };

describe('VogonApprovalStore', () => {
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
