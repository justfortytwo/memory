// guide's implementation of vogon's host-integration seam.
//
// @justfortytwo/vogon (the safety gate) defines the ApprovalStore + AuditLogger
// interfaces but ships only standalone in-memory / JSONL stores. This file is the
// RICHER, durable backing the gate's `decide()` accepts via opts.store / opts.audit:
// a transactional store + audit trail backed by guide's own SQLite db.
//
// Dependency direction is ONE-WAY: guide -> vogon (we import vogon's TYPES; vogon
// never imports guide). No cycle. vogon is a peerDependency of guide.
//
// The interface wiring here is REAL — the class implements ApprovalStore and
// AuditLogger against guide's DbHandles. The method BODIES are TODO(impl): the
// schema (an approvals + audit_log table) is sketched but not yet migrated, so the
// concrete SQL is deferred until a guide migration adds those tables.

import type {
  ApprovalStore,
  AuditLogger,
  AuditEntry,
  ApprovalStatus,
  PendingApproval,
  AddPendingInput,
} from '@justfortytwo/vogon';
import type { DbHandles } from './db.js';

/**
 * SQLite-backed ApprovalStore + AuditLogger for the vogon gate.
 *
 * Pass an instance to vogon's `decide(manifest, ctx, { store, audit })` so staged
 * one-shot approvals and the audit trail live in guide's durable db instead of the
 * gate's process-local / JSONL defaults.
 *
 * TODO(impl): add a guide migration (003_approvals) creating:
 *   - `approvals`  (id, tool, target, payload json, tier, tool_use_id, session_id,
 *                   status, created_at, updated_at) keyed/indexed on tool_use_id
 *   - `audit_log`  (id, ts, actor, kind, content, approval_status, meta json)
 * then implement the methods below as transactions on `this.h.raw` (single-writer,
 * matching guide's existing write pattern). markExecutedByToolUseId MUST be the
 * atomic approved->executed compare-and-set that makes the approval one-shot.
 */
export class VogonApprovalStore implements ApprovalStore, AuditLogger {
  constructor(private readonly h: DbHandles) {}

  async addPending(input: AddPendingInput): Promise<string> {
    // TODO(impl): INSERT a pending approval row (status 'pending') and return its id.
    void this.h; void input;
    throw new Error('VogonApprovalStore.addPending is a stub — see TODO(impl) in vogon-approval-store.ts');
  }

  async getByToolUseId(toolUseId: string): Promise<PendingApproval | undefined> {
    // TODO(impl): SELECT the most-recent approvals row for this tool_use_id.
    void toolUseId;
    throw new Error('VogonApprovalStore.getByToolUseId is a stub — see TODO(impl) in vogon-approval-store.ts');
  }

  async markExecutedByToolUseId(toolUseId: string): Promise<boolean> {
    // TODO(impl): atomic compare-and-set 'approved' -> 'executed' in a transaction;
    //   return true exactly once, false on any later call (the one-shot guarantee).
    void toolUseId;
    throw new Error('VogonApprovalStore.markExecutedByToolUseId is a stub — see TODO(impl) in vogon-approval-store.ts');
  }

  async setDecisionByToolUseId(toolUseId: string, status: 'approved' | 'denied', by?: string): Promise<boolean> {
    // TODO(impl): UPDATE the staged row's status (approve/deny) recording `by`.
    void toolUseId; void status; void by;
    throw new Error('VogonApprovalStore.setDecisionByToolUseId is a stub — see TODO(impl) in vogon-approval-store.ts');
  }

  async log(entry: AuditEntry): Promise<void> {
    // TODO(impl): INSERT an audit_log row from the entry.
    void entry; void (null as unknown as ApprovalStatus);
    throw new Error('VogonApprovalStore.log is a stub — see TODO(impl) in vogon-approval-store.ts');
  }
}
