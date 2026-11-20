import type { Knex } from 'knex';

// Outbox stamp for staged approvals. NULL means the owner has not been told about
// this approval yet; the scheduler polls for such rows, notifies, then stamps it.
// Memory itself queues no job for it. Rows that exist when this runs start
// NULL, so they are notified (again) once: at least once, never zero times.
export async function up(k: Knex): Promise<void> {
  await k.schema.alterTable('approvals', (t) => {
    t.string('notified_at').nullable();
  });
}

export async function down(k: Knex): Promise<void> {
  await k.schema.alterTable('approvals', (t) => {
    t.dropColumn('notified_at');
  });
}
