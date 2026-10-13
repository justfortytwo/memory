// Library-only insertion cursor. No semantic retrieval, embedder or MCP tool.
import type { DbHandles } from './db.js';
import type { MemoryRow } from './memory.js';
export interface MemoryCursor { database: string; position: number }
export function memoryHead(h: DbHandles): MemoryCursor {
  const identity = h.raw.prepare('SELECT identity FROM memory_identity WHERE id=1').get() as { identity: string } | undefined;
  if (!identity) throw new Error('Memory identity missing; run migrations');
  // AUTOINCREMENT high watermark survives deletion of the newest/all rows.
  const sequence = h.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='memories'").get() as { seq: number } | undefined;
  return { database: identity.identity, position: sequence?.seq ?? 0 };
}
export function memoryDelta(h: DbHandles, cursor: MemoryCursor, limit = 50): { cursor: MemoryCursor; entries: MemoryRow[] } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid delta limit');
  return h.raw.transaction(() => {
    const head = memoryHead(h);
    if (cursor.database !== head.database || !Number.isSafeInteger(cursor.position) || cursor.position < 0 || cursor.position > head.position) throw new Error('Invalid memory database cursor');
    const rows = h.raw.prepare('SELECT * FROM memories WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?').all(cursor.position, head.position, limit + 1) as MemoryRow[];
    const more = rows.length > limit;
    const entries = rows.slice(0, limit);
    return { entries, cursor: { database: head.database, position: more ? entries[entries.length - 1]!.id : head.position } };
  })();
}
