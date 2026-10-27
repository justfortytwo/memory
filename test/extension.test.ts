import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { FakeEmbedder } from '../src/embedder.js';
import { createServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { loadExtensions, type McpExtension } from '../src/extension.js';

let dir: string;
let h: DbHandles;
const emb = new FakeEmbedder();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-ext-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { vi.restoreAllMocks(); h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

const echoTool = (name: string) => ({
  name,
  description: 'ext tool',
  inputSchema: { type: 'object' as const, properties: {} },
});

function makeExt(names: string[], instructions?: string): McpExtension {
  return {
    tools: () => names.map(echoTool),
    call: async (name, args) => (names.includes(name) ? { ext: name, args } : undefined),
    ...(instructions ? { instructions } : {}),
  };
}

async function connect(exts: McpExtension[]) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0.0.0' });
  await createServer(h, emb, exts).connect(s);
  await client.connect(c);
  return client;
}

describe('createServer with extensions', () => {
  it('lists memory tools first, then extension tools', async () => {
    const client = await connect([makeExt(['ext_a'])]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const mem = toolDefinitions().map((t) => t.name);
    expect(names).toEqual([...mem, 'ext_a']);
    await client.close();
  });

  it('routes extension calls; unknown tool still throws', async () => {
    const client = await connect([makeExt(['ext_a'])]);
    const r = await client.callTool({ name: 'ext_a', arguments: { q: 1 } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual({ ext: 'ext_a', args: { q: 1 } });
    await expect(client.callTool({ name: 'x', arguments: {} })).rejects.toThrow('Unknown tool: x');
    await client.close();
  });

  it('skips an extension tool that collides with a memory tool and logs to stderr', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = await connect([makeExt(['recall', 'ext_b'])]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n === 'recall')).toHaveLength(1);
    expect(names).toContain('ext_b');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('recall'))).toBe(true);
    await client.callTool({ name: 'store', arguments: { text: 'hello world' } });
    const r = await client.callTool({ name: 'recall', arguments: { query: 'hello' } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain('"ext"');
    await client.close();
  });

  it('appends extension instructions after memory text', async () => {
    const client = await connect([makeExt(['ext_a'], 'EXT-GUIDE')]);
    const ins = client.getInstructions()!;
    expect(ins).toContain('EXT-GUIDE');
    expect(ins.indexOf('EXT-GUIDE')).toBeGreaterThan(ins.indexOf('Persistent memory'));
    await client.close();
  });
});

describe('loadExtensions', () => {
  it('resolves [] and logs when the importer throws', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = await loadExtensions(['bad'], h, emb, async () => { throw new Error('nope'); });
    expect(out).toEqual([]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('bad'))).toBe(true);
  });

  it('skips a module without createMcpExtension', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = await loadExtensions(['empty'], h, emb, async () => ({}));
    expect(out).toEqual([]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('empty'))).toBe(true);
  });

  it('loads a valid module', async () => {
    const ext = makeExt(['ext_a']);
    const out = await loadExtensions(['good'], h, emb, async () => ({ createMcpExtension: () => ext }));
    expect(out).toEqual([ext]);
  });
});
