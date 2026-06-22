import type { Knex } from 'knex';

// SQLite-only (FTS5 is built in). The triggers keep memory_fts in sync with the
// `memories` content column. Generic rename of Ford's journal_fts (003_fts).
export async function up(k: Knex): Promise<void> {
  if (k.client.config.client !== 'better-sqlite3') return;
  await k.raw(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='memories', content_rowid='id')`);
  await k.raw(`CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END`);
  await k.raw(`CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.id, old.content);
  END`);
  await k.raw(`CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END`);
}

export async function down(k: Knex): Promise<void> {
  if (k.client.config.client !== 'better-sqlite3') return;
  await k.raw('DROP TRIGGER IF EXISTS memory_au');
  await k.raw('DROP TRIGGER IF EXISTS memory_ad');
  await k.raw('DROP TRIGGER IF EXISTS memory_ai');
  await k.raw('DROP TABLE IF EXISTS memory_fts');
}
