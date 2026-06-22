import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { FakeEmbedder } from '../src/embedder.js';
import { callTool } from '../src/dispatch.js';

let dir: string;
let h: DbHandles;
const fake = new FakeEmbedder();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-disp-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('callTool — the MCP tool surface', () => {
  it('routes store -> a numeric id and query -> the stored row', async () => {
    const id = await callTool(h, fake, 'store', { content: 'hello', source: 'owner' });
    expect(typeof id).toBe('number');

    const rows = (await callTool(h, fake, 'query', { source: 'owner' })) as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hello');
  });

  it('maps the query `live_only` wire field to the store option', async () => {
    const a = await callTool(h, fake, 'store', { content: 'first' }) as number;
    await callTool(h, fake, 'store', { content: 'second', supersedes: a }); // supersede #a
    const live = (await callTool(h, fake, 'query', {})) as unknown[];
    const all = (await callTool(h, fake, 'query', { live_only: false })) as unknown[];
    expect(live.length).toBe(1);  // superseded row hidden
    expect(all.length).toBe(2);   // history visible
  });

  it('rejects an unknown tool', async () => {
    await expect(callTool(h, fake, 'nope', {})).rejects.toThrow(/unknown tool/i);
  });
});
