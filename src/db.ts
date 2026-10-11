import Database from 'better-sqlite3';
import knexPkg, { type Knex } from 'knex';
import * as sqliteVec from 'sqlite-vec';

// knex ships as CommonJS; under NodeNext ESM (`node dist/index.js`) a named
// import `{ knex }` throws "Named export 'knex' not found". Default-import the
// namespace and destructure — identical binding, ESM-safe. (vitest interops the
// named form fine, which is why db.test passes but the raw-node server did not.)
const { knex } = knexPkg;

/** Embedding dimensionality. qwen3-embedding:0.6b emits 1024-dim vectors. */
export const EMBED_DIM = 1024;

/** How long a connection waits for another writer (e.g. a concurrent process's migrations). */
const BUSY_TIMEOUT_MS = 5000;

export interface DbHandles {
  /** Raw handle: sqlite-vec + FTS5 ops, and atomic relational+vector writes. */
  raw: Database.Database;
  /** Knex handle: migrations + portable relational reads/writes. */
  k: Knex;
}

/**
 * Switch the file to WAL (persistent; a no-op once the file is already WAL).
 *
 * When processes open the same fresh file at once, each pragma reads the header
 * under a shared lock and then upgrades to write it. While one connection holds
 * the write lock, SQLite fails the others' upgrade with SQLITE_BUSY immediately,
 * skipping busy_timeout, because waiting there could deadlock. A loser waits for
 * that writer with BEGIN IMMEDIATE (a lock request made with no lock held, so it
 * does honor busy_timeout), then retries once and finds the file already WAL.
 * A second BUSY is a real lock problem and is thrown.
 */
function enableWal(raw: Database.Database): void {
  try {
    raw.pragma('journal_mode = WAL');
  } catch (e) {
    if ((e as { code?: string }).code !== 'SQLITE_BUSY') throw e;
    raw.exec('BEGIN IMMEDIATE; ROLLBACK');
    raw.pragma('journal_mode = WAL');
  }
}

export function openDb(dbPath: string): DbHandles {
  const raw = new Database(dbPath);
  // busy_timeout first: switching a fresh file to WAL and the vec0 DDL below both
  // need the write lock, which another process may hold during concurrent startup.
  raw.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  enableWal(raw);
  sqliteVec.load(raw); // registers the vec0 module + scalar helpers

  // vec0 tables live on the raw handle: sqlite-vec is loaded here, NOT on Knex's
  // own connection, so Knex migrations cannot create vec0 tables. (FTS5, which is
  // compiled into SQLite, and the relational schema CAN be Knex migrations.)
  //
  // `memory_vec` indexes the generic memory store; `doc_vec` indexes reindexed
  // markdown documents. (Generic rename of the original assistant's `journal_vec`.)
  //
  // Every process runs this on open, so it is one BEGIN IMMEDIATE transaction:
  // the write lock is taken (waiting up to busy_timeout) before the existence
  // checks, so concurrent first-opens create the tables exactly once.
  raw.transaction(() => {
    raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${EMBED_DIM}])`);
    raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS doc_vec USING vec0(embedding float[${EMBED_DIM}])`);
  }).immediate();

  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: dbPath },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      // Explicit, not better-sqlite3's implicit default: runMigrations waits on
      // this connection for another process's migration transaction to commit.
      afterCreate: (conn: Database.Database, done: (err: Error | null, conn: Database.Database) => void) => {
        conn.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
        done(null, conn);
      },
    },
  });

  return { raw, k };
}
