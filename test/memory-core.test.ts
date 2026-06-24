import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { FakeEmbedder } from '../src/embedder.js';
import {
  store, query, recall, lexical, reindex, recallDocs, exportRange, reembed, deleteByIds,
} from '../src/memory.js';

let dir: string;
let h: DbHandles;
const e = new FakeEmbedder();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-core-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('store + supersede', () => {
  it('supersede keeps history but hides the stale row from live reads', async () => {
    const a = await store(h, e, { content: 'lives in Berlin', source: 'owner' });
    const b = await store(h, e, { content: 'lives in Lisbon', source: 'owner', supersedes: a });

    const live = await query(h, {});
    expect(live.map((r) => r.id)).toEqual([b]); // newest live row only

    const all = await query(h, { liveOnly: false });
    expect(all.map((r) => r.id).sort()).toEqual([a, b].sort());

    const old = all.find((r) => r.id === a)!;
    expect(old.superseded_by).toBe(b); // history linked forward, not destroyed
  });
});

describe('query filters', () => {
  beforeEach(async () => {
    await store(h, e, { content: 'm1', source: 'owner', observed: 'stated', tags: ['x'], date: '2026-01-01' });
    await store(h, e, { content: 'm2', source: 'web', observed: 'inferred', tags: ['y'], date: '2026-02-01' });
  });
  it('filters by source / observed / tag', async () => {
    expect((await query(h, { source: 'owner' })).map((r) => r.content)).toEqual(['m1']);
    expect((await query(h, { observed: 'inferred' })).map((r) => r.content)).toEqual(['m2']);
    expect((await query(h, { tag: 'x' })).map((r) => r.content)).toEqual(['m1']);
  });
  it('honors limit', async () => {
    expect(await query(h, { limit: 1 })).toHaveLength(1);
  });
});

describe('recall (semantic)', () => {
  it('returns the matching memory with a distance, excludes superseded, honors k', async () => {
    const a = await store(h, e, { content: 'the deploy key rotates monthly' });
    await store(h, e, { content: 'lunch is at noon' });

    const hits = await recall(h, e, 'the deploy key rotates monthly', 5);
    expect(hits[0].content).toBe('the deploy key rotates monthly');
    expect(hits[0]).toHaveProperty('distance');

    await store(h, e, { content: 'the deploy key rotates weekly', supersedes: a });
    const after = await recall(h, e, 'the deploy key rotates monthly', 5);
    expect(after.map((r) => r.content)).not.toContain('the deploy key rotates monthly'); // superseded hidden
  });
});

describe('lexical (FTS5)', () => {
  it('matches keywords, is chaining-safe on multi-token input, and hides superseded rows', async () => {
    const a = await store(h, e, { content: 'quarterly pricing review notes' });
    await store(h, e, { content: 'unrelated grocery list' });

    expect(lexical(h, 'pricing', 10)).toHaveLength(1);
    expect(lexical(h, 'pricing review', 10)).toHaveLength(1); // tokens AND-ed, quoted defensively
    expect(lexical(h, 'pricing nonexistentword', 10)).toHaveLength(0);

    await store(h, e, { content: 'quarterly pricing review revised', supersedes: a });
    expect(lexical(h, 'notes', 10)).toHaveLength(0); // superseded original hidden
  });
});

describe('reindex + recall_docs', () => {
  it('indexes markdown, is idempotent on unchanged files, and prunes removed files', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'jf-docs-'));
    writeFileSync(join(docs, 'a.md'), '# Alpha\nthe alpha protocol');
    writeFileSync(join(docs, 'b.md'), '# Beta\nthe beta protocol');

    expect(await reindex(h, e, docs)).toEqual({ indexed: 2, removed: 0 });
    expect(await reindex(h, e, docs)).toEqual({ indexed: 0, removed: 0 }); // unchanged -> skipped

    const hit = await recallDocs(h, e, 'the alpha protocol', 5);
    expect(hit[0].file_path).toContain('a.md');
    expect(hit[0].preview).toContain('alpha');

    unlinkSync(join(docs, 'b.md'));
    expect(await reindex(h, e, docs)).toEqual({ indexed: 0, removed: 1 }); // vanished -> pruned
    rmSync(docs, { recursive: true, force: true });
  });
});

describe('deleteByIds (owner-privileged hard delete)', () => {
  it('removes the row from memories, vector recall, AND lexical FTS so nothing resurfaces', async () => {
    const secret = await store(h, e, { content: 'alpha launch code is 4242' });
    const keep = await store(h, e, { content: 'beta is public knowledge' });

    expect(deleteByIds(h, [secret])).toBe(1);

    // gone from structured query
    expect((await query(h, { liveOnly: false })).map((r) => r.id)).toEqual([keep]);
    // gone from semantic recall
    expect((await recall(h, e, 'alpha launch code is 4242', 5)).map((r) => r.id)).not.toContain(secret);
    // gone from lexical FTS (the AFTER-DELETE trigger cleaned it)
    expect(lexical(h, 'alpha', 10).map((r) => r.id)).not.toContain(secret);
    // the other memory is untouched
    expect(lexical(h, 'beta', 10).map((r) => r.id)).toEqual([keep]);
  });

  it('deletes multiple ids and reports the count; empty input is a no-op', async () => {
    const a = await store(h, e, { content: 'one' });
    const b = await store(h, e, { content: 'two' });
    expect(deleteByIds(h, [])).toBe(0);
    expect(deleteByIds(h, [a, b, 999999])).toBe(2); // missing id ignored
    expect(await query(h, {})).toHaveLength(0);
  });
});

describe('export_range + reembed', () => {
  it('renders a markdown range and notes an empty one', async () => {
    await store(h, e, { content: 'dated note', source: 'owner', date: '2026-03-15' });
    const md = await exportRange(h, '2000-01-01', '2999-01-01');
    expect(md).toContain('dated note');
    expect(await exportRange(h, '1990-01-01', '1990-12-31')).toContain('no entries');
  });
  it('reembed returns true for an existing memory, false for a missing id', async () => {
    const id = await store(h, e, { content: 'embed me' });
    expect(await reembed(h, e, id)).toBe(true);
    expect(await reembed(h, e, 999999)).toBe(false);
  });
});
