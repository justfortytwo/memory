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

// Safe under concurrent first-open: Telegram and Scheduler (separate OS
// processes) both call openDb + runMigrations on the same DB at startup.
//
// The critical section is serialized by SQLite's database write lock:
//   1. take the write lock (waits up to busy_timeout if another process holds it)
//   2. only then read `_migration_state`
//   3. apply every pending migration and record each in `_migration_state`
//   4. commit: DDL and state rows land together or not at all
// A second process waits at step 1, then reads the committed state and finds
// nothing pending.
//
// Step 1 is the transaction's first statement, a write to `_migration_lock`. This
// is what BEGIN IMMEDIATE does, but knex's SQLite dialect always issues a deferred
// `BEGIN;`. With a deferred BEGIN, a transaction that read first and wrote later
// could not wait for the lock: SQLite returns SQLITE_BUSY at once (deadlock
// avoidance). Writing before any read makes the lock request wait instead.
// `_migration_lock` itself is created by a single autocommit statement, which
// SQLite runs under the write lock and re-checks after a concurrent schema change.
export async function runMigrations(k: Knex): Promise<void> {
  await k.raw(
    `CREATE TABLE IF NOT EXISTS _migration_lock (
       id integer primary key check (id = 1),
       locked_at text not null
     )`,
  );
  await k.transaction(async (trx) => {
    await trx.raw(
      `INSERT INTO _migration_lock (id, locked_at) VALUES (1, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET locked_at = excluded.locked_at`,
    );
    await trx.raw(
      `CREATE TABLE IF NOT EXISTS _migration_state (
         name text primary key,
         applied_at text not null default (datetime('now'))
       )`,
    );
    const rows = (await trx.raw('SELECT name FROM _migration_state')) as Array<{ name: string }>;
    const done = new Set((Array.isArray(rows) ? rows : []).map((r) => r.name));
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      await m.up(trx);
      await trx.raw('INSERT INTO _migration_state (name) VALUES (?)', [m.name]);
    }
  });
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
