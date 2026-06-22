#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb } from './db.js';
import { runMigrations } from './migrate.js';
import { FakeEmbedder, OllamaEmbedder, type Embedder } from './embedder.js';
import { toolDefinitions } from './tools.js';
import {
  store, query, recall, recallDocs, lexical, reindex, exportRange,
} from './memory.js';
import { GUIDE_SERVER_ID } from './contract.js';

// Public surface re-exports so consumers can `import { ... } from '@justfortytwo/guide'`.
export * from './contract.js';
export * from './embedder.js';
export { openDb, type DbHandles, EMBED_DIM } from './db.js';
export { runMigrations } from './migrate.js';
export {
  store, query, recall, recallDocs, lexical, reindex, exportRange, reembed,
  type MemoryInput, type MemoryRow, type RecallRow, type QueryOpts,
  type DocRecallRow, type ReindexResult,
} from './memory.js';
export { enrich, enrichFromTurn, type EnrichmentCandidate, type EnrichmentResult } from './enrichment.js';
export { toolDefinitions } from './tools.js';
// guide's implementation of vogon's ApprovalStore + AuditLogger seam (guide -> vogon).
export { VogonApprovalStore } from './vogon-approval-store.js';

// Standalone, Ford-agnostic: DB_PATH (env) or ./memory.db. No repo-root coupling.
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
  { name: GUIDE_SERVER_ID, version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions(),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, unknown>;
  let result: unknown;
  switch (name) {
    case 'store':
      result = await store(h, embedder, {
        content: String(a.content),
        source: a.source as string | undefined,
        observed: a.observed as string | undefined,
        date: a.date as string | undefined,
        tags: Array.isArray(a.tags) ? (a.tags as string[]) : undefined,
        meta: a.meta as Record<string, unknown> | undefined,
        supersedes: a.supersedes as number | undefined,
      });
      break;
    case 'query':
      result = await query(h, {
        source: a.source as string | undefined,
        observed: a.observed as string | undefined,
        tag: a.tag as string | undefined,
        since: a.since as string | undefined,
        until: a.until as string | undefined,
        liveOnly: a.live_only as boolean | undefined,
        limit: a.limit as number | undefined,
      });
      break;
    case 'recall':
      result = await recall(h, embedder, String(a.text), (a.k as number) ?? 5);
      break;
    case 'recall_docs':
      result = await recallDocs(h, embedder, String(a.text), (a.k as number) ?? 5);
      break;
    case 'lexical':
      result = lexical(h, String(a.text), (a.k as number) ?? 50);
      break;
    case 'reindex':
      result = await reindex(h, embedder, String(a.root));
      break;
    case 'export_range':
      result = await exportRange(h, String(a.since), String(a.until));
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
