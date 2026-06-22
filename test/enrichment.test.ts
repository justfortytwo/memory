import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { FakeEmbedder } from '../src/embedder.js';
import { store, query } from '../src/memory.js';
import { enrich, enrichFromTurn, type EnrichmentCandidate } from '../src/enrichment.js';

let dir: string;
let h: DbHandles;
const e = new FakeEmbedder();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-enrich-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

const cand = (over: Partial<EnrichmentCandidate>): EnrichmentCandidate => ({ content: 'x', salience: 0.9, ...over });

describe('enrich — dedupe / supersede / write', () => {
  it('drops candidates below the salience threshold', async () => {
    const r = await enrich(h, e, [cand({ content: 'noise', salience: 0.1 })]);
    expect(r.skipped).toBe(1);
    expect(r.written).toHaveLength(0);
  });

  it('writes a novel candidate with its provenance', async () => {
    const r = await enrich(h, e, [cand({ content: 'the gate key is in 1password', source: 'owner', observed: 'stated' })]);
    expect(r.written).toHaveLength(1);
    const rows = await query(h, {});
    expect(rows[0].content).toBe('the gate key is in 1password');
    expect(rows[0].observed).toBe('stated');
  });

  it('skips a near-duplicate of an existing memory', async () => {
    await store(h, e, { content: 'identical fact' });
    const r = await enrich(h, e, [cand({ content: 'identical fact' })]);
    expect(r.skipped).toBe(1);
    expect(r.written).toHaveLength(0);
  });

  it('supersedes an existing memory when the candidate marks a contradiction', async () => {
    const old = await store(h, e, { content: 'office is on floor 2' });
    const r = await enrich(h, e, [cand({ content: 'office moved to floor 5', supersedes: old })]);
    expect(r.written).toHaveLength(1);
    expect(r.superseded).toEqual([old]);
    const all = await query(h, { liveOnly: false });
    expect(all.find((row) => row.id === old)!.superseded_by).toBe(r.written[0]);
  });
});

describe('enrichFromTurn', () => {
  it('runs the injected salience extractor, then enriches', async () => {
    const extractor = { extractSalient: async () => [cand({ content: 'turn-derived fact' })] };
    const r = await enrichFromTurn(h, e, { text: 'whatever' }, extractor);
    expect(r.written).toHaveLength(1);
    expect((await query(h, {}))[0].content).toBe('turn-derived fact');
  });
});
