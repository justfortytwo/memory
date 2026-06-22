import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { FakeEmbedder } from '../src/embedder.js';
import { store, query, recall, lexical } from '../src/memory.js';

let dir: string;
let h: DbHandles;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-mem-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('store + query + recall (placeholder smoke test)', () => {
  it('stores a memory, finds it by structured query, recall, and FTS', async () => {
    const id = await store(h, new FakeEmbedder(), {
      content: 'the q3 pricing strategy is finalised',
      source: 'owner',
      observed: 'stated',
      tags: ['pricing'],
    });
    expect(id).toBeGreaterThan(0);

    const rows = await query(h, { source: 'owner', tag: 'pricing' });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('q3 pricing');

    const recalled = await recall(h, new FakeEmbedder(), 'q3 pricing', 3);
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0]).toHaveProperty('distance');

    const lex = lexical(h, 'pricing', 10);
    expect(lex.length).toBe(1);
  });
});
