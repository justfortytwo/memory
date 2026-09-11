import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { FakeEmbedder } from '../src/embedder.js';
import { createServer } from '../src/server.js';

let dir: string;
let h: DbHandles;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-srv-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('createServer — the MCP initialize handshake', () => {
  it('advertises usage instructions to the connecting client', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await createServer(h, new FakeEmbedder()).connect(serverSide);
    await client.connect(clientSide);

    expect(client.getInstructions()).toEqual(expect.stringMatching(/\S/));

    await client.close();
  });
});
