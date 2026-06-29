import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('jobs', (t) => {
    t.increments('id').primary();
    t.text('kind').notNullable();
    t.text('payload');
    t.text('run_at').notNullable();
    t.text('recurrence');
    t.text('status').notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.text('created_at').notNullable();
    t.text('updated_at').notNullable();
    t.index(['status', 'run_at'], 'idx_jobs_status_run_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('jobs');
}
