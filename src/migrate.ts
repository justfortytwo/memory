import type { Knex } from 'knex';
import { openDb } from './db.js';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as m001 from './migrations/001_init.js';
import * as m002 from './migrations/002_fts.js';
import * as m003 from './migrations/003_approvals.js';
import * as m004 from './migrations/004_jobs.js';

type Migration = { up(k: Knex): Promise<void>; down(k: Knex): Promise<void> };

// Static import list — deterministic under both vitest (resolves .js → .ts) and
// the built server (dist/migrations/*.js). No knex CLI, no dynamic-import path
// fragility.
const MIGRATIONS: Array<{ name: string } & Migration> = [
  { name: '001_init', up: m001.up, down: m001.down },
  { name: '002_fts', up: m002.up, down: m002.down },
  { name: '003_approvals', up: m003.up, down: m003.down },
  { name: '004_jobs', up: m004.up, down: m004.down },
];

export async function runMigrations(k: Knex): Promise<void> {
  await k.raw(
    `CREATE TABLE IF NOT EXISTS _migration_state (
       name text primary key,
       applied_at text not null default (datetime('now'))
     )`,
  );
  const rows = (await k.raw('SELECT name FROM _migration_state')) as Array<{ name: string }>;
  const done = new Set((Array.isArray(rows) ? rows : []).map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await m.up(k);
    await k.raw('INSERT INTO _migration_state (name) VALUES (?)', [m.name]);
  }
}

// `npm run migrate` entry point: open the DB at DB_PATH and apply migrations.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve('memory.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const h = openDb(dbPath);
  await runMigrations(h.k);
  await h.k.destroy();
  // eslint-disable-next-line no-console
  console.error(`[memory] migrations applied to ${dbPath}`);
}
