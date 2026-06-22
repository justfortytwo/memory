// guide's implementation of vogon's host-integration seam.
//
// @justfortytwo/vogon (the safety gate) defines the ApprovalStore + AuditLogger
// interfaces but ships only standalone in-memory / JSONL stores. This is the
// RICHER, durable backing the gate's `decide()` accepts via opts.store / opts.audit:
// a transactional store + audit trail on guide's own SQLite db (tables created by
// migration 003_approvals).
//
// Dependency direction is ONE-WAY: guide -> vogon (we import vogon's TYPES; vogon
// never imports guide). No cycle. vogon is a peerDependency of guide.

import { randomUUID } from 'node:crypto';
import type {
  ApprovalStore,
  AuditLogger,
  AuditEntry,
  ApprovalStatus,
  PendingApproval,
  AddPendingInput,
} from '@justfortytwo/vogon';
import type { DbHandles } from './db.js';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fail-closed transition guard (same invariant as vogon's stock stores): only a
 * pending call may be approved/denied, and an approval may be revoked (-> denied)
 * before it is consumed. Terminal states (executed/denied/expired) are immutable,
 * so a decision can never resurrect a spent or denied one-shot.
 */
function canDecide(current: string, next: 'approved' | 'denied'): boolean {
  if (current === 'pending') return true;
  if (current === 'approved' && next === 'denied') return true;
  return false;
}

interface ApprovalRowDb {
  id: string;
  tool: string;
  target: string;
  payload: string;
  tier: string;
  tool_use_id: string;
  session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function toApproval(r: ApprovalRowDb): PendingApproval {
  return {
    id: r.id,
    tool: r.tool,
    target: r.target,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    tier: r.tier,
    tool_use_id: r.tool_use_id,
    session_id: r.session_id,
    status: r.status as ApprovalStatus,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * SQLite-backed ApprovalStore + AuditLogger for the vogon gate. Pass an instance
 * to vogon's `decide(manifest, ctx, { store, audit })` so staged one-shots and the
 * audit trail live in guide's durable db instead of the gate's JSONL default.
 */
export class VogonApprovalStore implements ApprovalStore, AuditLogger {
  constructor(private readonly h: DbHandles) {}

  async addPending(input: AddPendingInput): Promise<string> {
    const id = `pa_${randomUUID()}`;
    const ts = nowIso();
    this.h.raw
      .prepare(
        `INSERT INTO approvals
           (id, tool, target, payload, tier, tool_use_id, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.tool,
        input.target,
        JSON.stringify(input.payload ?? {}),
        input.tier,
        input.tool_use_id,
        input.session_id ?? null,
        ts,
        ts,
      );
    return id;
  }

  async getByToolUseId(toolUseId: string): Promise<PendingApproval | undefined> {
    const row = this.h.raw
      .prepare(
        `SELECT * FROM approvals WHERE tool_use_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(toolUseId) as ApprovalRowDb | undefined;
    return row ? toApproval(row) : undefined;
  }

  async markExecutedByToolUseId(toolUseId: string): Promise<boolean> {
    // Atomic compare-and-set approved -> executed: succeeds exactly once.
    const txn = this.h.raw.transaction(() => {
      const info = this.h.raw
        .prepare(
          `UPDATE approvals SET status = 'executed', updated_at = ?
            WHERE tool_use_id = ? AND status = 'approved'`,
        )
        .run(nowIso(), toolUseId);
      return info.changes > 0;
    });
    return txn();
  }

  async setDecisionByToolUseId(toolUseId: string, status: 'approved' | 'denied', _by?: string): Promise<boolean> {
    const txn = this.h.raw.transaction(() => {
      const row = this.h.raw
        .prepare(`SELECT id, status FROM approvals WHERE tool_use_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(toolUseId) as { id: string; status: string } | undefined;
      if (!row || !canDecide(row.status, status)) return false;
      this.h.raw
        .prepare(`UPDATE approvals SET status = ?, updated_at = ? WHERE id = ?`)
        .run(status, nowIso(), row.id);
      return true;
    });
    return txn();
  }

  async list(): Promise<PendingApproval[]> {
    const rows = this.h.raw
      .prepare(`SELECT * FROM approvals ORDER BY created_at ASC, id ASC`)
      .all() as ApprovalRowDb[];
    return rows.map(toApproval);
  }

  async log(entry: AuditEntry): Promise<void> {
    this.h.raw
      .prepare(
        `INSERT INTO audit_log (actor, kind, content, approval_status, meta) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.actor, entry.kind, entry.content, entry.approval_status ?? null, JSON.stringify(entry.meta ?? {}));
  }
}
