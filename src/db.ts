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

export interface DbHandles {
  /** Raw handle: sqlite-vec + FTS5 ops, and atomic relational+vector writes. */
  raw: Database.Database;
  /** Knex handle: migrations + portable relational reads/writes. */
  k: Knex;
}

export function openDb(dbPath: string): DbHandles {
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000'); // wait up to 5s on writer contention
  sqliteVec.load(raw); // registers the vec0 module + scalar helpers

  // vec0 tables live on the raw handle: sqlite-vec is loaded here, NOT on Knex's
  // own connection, so Knex migrations cannot create vec0 tables. (FTS5, which is
  // compiled into SQLite, and the relational schema CAN be Knex migrations.)
  //
  // `memory_vec` indexes the generic memory store; `doc_vec` indexes reindexed
  // markdown documents. (Generic rename of the original assistant's `journal_vec`.)
  const ddl = (sql: string) => raw.exec(sql);
  ddl(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${EMBED_DIM}])`);
  ddl(`CREATE VIRTUAL TABLE IF NOT EXISTS doc_vec USING vec0(embedding float[${EMBED_DIM}])`);

  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: dbPath },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });

  return { raw, k };
}
