#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, realpathSync } from 'node:fs';
import { openDb } from './db.js';
import { runMigrations } from './migrate.js';
import { FakeEmbedder, OllamaEmbedder, type Embedder } from './embedder.js';
import { toolDefinitions } from './tools.js';
import { callTool } from './dispatch.js';
import { MEMORY_SERVER_ID } from './contract.js';

// Public surface re-exports so consumers can `import { ... } from '@justfortytwo/memory'`.
export * from './contract.js';
export * from './embedder.js';
export { openDb, type DbHandles, EMBED_DIM } from './db.js';
export { runMigrations } from './migrate.js';
export {
  store, query, recall, recallDocs, lexical, reindex, exportRange, reembed, deleteByIds,
  type MemoryInput, type MemoryRow, type RecallRow, type QueryOpts,
  type DocRecallRow, type ReindexResult,
} from './memory.js';
export { enrich, enrichFromTurn, type EnrichmentCandidate, type EnrichmentResult } from './enrichment.js';
export { enqueue, claimDue, complete, fail, listRecurring, requeueStale, existsPending, MAX_ATTEMPTS, type JobRow, type NewJob } from './jobs.js';
export { toolDefinitions } from './tools.js';
// memory's implementation of gate's ApprovalStore + AuditLogger seam (memory -> gate).
export { GateApprovalStore } from './gate-approval-store.js';

/**
 * Boot the MCP server over stdio. Kept behind an entrypoint guard so that
 * IMPORTING this package as a library (e.g. the installer calling
 * `runMigrations`/`openDb`) does NOT open a DB, run migrations, or connect a
 * transport. Only running the `fortytwo-memory` bin directly starts the server.
 */
export async function startServer(): Promise<void> {
  // Standalone, persona-agnostic: DB_PATH (env) or ./memory.db. No repo-root coupling.
  const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve('memory.db');

  // EMBED_MODEL present → real Ollama embedder; absent → deterministic FakeEmbedder
  // (lets the server boot with zero infra for tests / first-run smoke checks).
  const embedder: Embedder = process.env.EMBED_MODEL
    ? new OllamaEmbedder(process.env.EMBED_MODEL, process.env.OLLAMA_BASE_URL)
    : new FakeEmbedder();

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const h = openDb(DB_PATH);
  await runMigrations(h.k);

  const server = new Server(
    { name: MEMORY_SERVER_ID, version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const result = await callTool(h, embedder, name, args as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the server only when invoked directly as the `fortytwo-memory` bin.
// Realpath comparison so the npm bin symlink resolves to this module.
function invokedAsBin(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedAsBin()) {
  startServer().catch((err) => {
    process.stderr.write(`fortytwo-memory: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
