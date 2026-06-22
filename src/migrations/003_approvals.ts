import type { Knex } from 'knex';

// Durable backing for vogon's ApprovalStore + AuditLogger seam (see
// vogon-approval-store.ts). `approvals` holds staged one-shot approvals keyed by
// tool_use_id; `audit_log` is an append-only trail. Both live on guide's db so a
// host can give the gate a transactional store instead of its JSONL default.
export async function up(k: Knex): Promise<void> {
  await k.schema
    .createTable('approvals', (t) => {
      t.string('id').primary();              // pa_<uuid>
      t.string('tool').notNullable();
      t.string('target').notNullable();
      t.text('payload').notNullable().defaultTo('{}');
      t.string('tier').notNullable();
      t.string('tool_use_id').notNullable();
      t.string('session_id').nullable();
      t.string('status').notNullable().defaultTo('pending'); // pending|approved|denied|executed|expired
      t.string('created_at').notNullable();
      t.string('updated_at').notNullable();
      t.index(['tool_use_id']);
      t.index(['status']);
    })
    .createTable('audit_log', (t) => {
      t.increments('id').primary();
      t.datetime('ts', { useTz: false }).notNullable().defaultTo(k.fn.now());
      t.string('actor').notNullable();
      t.string('kind').notNullable();
      t.text('content').notNullable();
      t.string('approval_status').nullable();
      t.text('meta').notNullable().defaultTo('{}');
    });
}

export async function down(k: Knex): Promise<void> {
  await k.schema.dropTableIfExists('audit_log').dropTableIfExists('approvals');
}
