import type { Knex } from 'knex';

// Generic memory store. Stripped from Ford's 001_init: the journal_entries
// channel/direction/actor/approval_status columns, the `entities` table, and
// the registry_pending / registry_reminders tables (all Ford orchestration).
//
// The vec0 tables (memory_vec, doc_vec) are created on the raw sqlite-vec
// handle in db.ts — NOT here — because Knex's connection does not load the
// sqlite-vec extension. FTS5 (compiled into SQLite) is a migration (002_fts).
export async function up(k: Knex): Promise<void> {
  await k.schema
    .createTable('memories', (t) => {
      t.increments('id').primary();
      t.datetime('ts', { useTz: false }).notNullable().defaultTo(k.fn.now());
      t.text('content').notNullable();
      t.string('source').nullable();   // free-form provenance: owner | web | tool:foo
      t.string('observed').nullable(); // free-form: stated | inferred | imported
      t.string('date').nullable();     // ISO date the memory pertains to
      t.text('tags').notNullable().defaultTo('[]');
      t.text('meta').notNullable().defaultTo('{}');
      // SUPERSEDE: links a stale row forward to the row that replaced it.
      // History is never destroyed — superseded rows remain queryable.
      t.integer('superseded_by').nullable();
      t.index(['ts']);
      t.index(['source']);
      t.index(['observed']);
      t.index(['date']);
      t.index(['superseded_by']);
    })
    .createTable('index_state', (t) => {
      t.increments('id').primary();
      t.string('file_path').notNullable().unique();
      t.string('sha256').notNullable();
      t.datetime('embedded_at', { useTz: false }).notNullable().defaultTo(k.fn.now());
    });
}

export async function down(k: Knex): Promise<void> {
  await k.schema
    .dropTableIfExists('index_state')
    .dropTableIfExists('memories');
}
