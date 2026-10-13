import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
// Stable identity for insertion cursors; replacement databases fail closed.
export async function up(k: Knex): Promise<void> {
  await k.schema.createTable('memory_identity', t => { t.integer('id').primary(); t.text('identity').notNullable(); });
  await k('memory_identity').insert({ id: 1, identity: randomUUID() });
}
export async function down(k: Knex): Promise<void> { await k.schema.dropTableIfExists('memory_identity'); }
