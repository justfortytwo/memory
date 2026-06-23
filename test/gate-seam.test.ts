// Cross-package seam: gate's REAL gate (decide) backed by memory's durable
// GateApprovalStore + audit. Proves memory can host the gate's approvals.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseManifest, decide, type Manifest } from '@justfortytwo/gate';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { GateApprovalStore } from '../src/gate-approval-store.js';

const MANIFEST = `
default_tier = "external"
[tiers]
"Read" = "read"
"mcp__messaging__*" = "external"
`;

let dir: string;
let h: DbHandles;
let store: GateApprovalStore;
let m: Manifest;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-seam-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
  store = new GateApprovalStore(h);
  m = parseManifest(MANIFEST);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe("the gate backed by memory's GateApprovalStore", () => {
  it('drives defer -> approve -> allow-once -> deny, recording an audit trail', async () => {
    const ctx = { toolName: 'mcp__messaging__send', toolInput: { to: 'x' }, toolUseId: 'tu_1' };

    expect((await decide(m, ctx, { store, audit: store })).permission).toBe('defer');
    await store.setDecisionByToolUseId('tu_1', 'approved');
    expect((await decide(m, ctx, { store, audit: store })).permission).toBe('allow'); // consumed once
    expect((await decide(m, ctx, { store, audit: store })).permission).toBe('deny');  // executed

    const audits = h.raw.prepare('SELECT kind FROM audit_log').all();
    expect(audits.length).toBeGreaterThan(0);
  });

  it('an approval cannot be resurrected to re-run an external call', async () => {
    const ctx = { toolName: 'mcp__messaging__send', toolInput: { to: 'x' }, toolUseId: 'tu_2' };
    await decide(m, ctx, { store, audit: store });          // defer
    await store.setDecisionByToolUseId('tu_2', 'approved');
    await decide(m, ctx, { store, audit: store });          // allow (consumed)
    expect(await store.setDecisionByToolUseId('tu_2', 'approved')).toBe(false); // refused
    expect((await decide(m, ctx, { store, audit: store })).permission).toBe('deny');
  });

  it('an auto-tier tool is allowed without staging anything', async () => {
    const d = await decide(m, { toolName: 'Read', toolInput: {}, toolUseId: 'tu_r' }, { store, audit: store });
    expect(d.permission).toBe('allow');
    expect(await store.list()).toHaveLength(0);
  });
});
