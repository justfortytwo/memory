import type { DbHandles } from './db.js';
import type { Embedder } from './embedder.js';
import { store, query, recall, recallDocs, lexical, reindex, exportRange } from './memory.js';

// Route a bare MCP tool name + arguments to the memory store and return the RAW
// result. The index.ts CallTool handler wraps this in the MCP content envelope;
// keeping the routing here (free of any MCP transport) makes the tool surface
// unit-testable. Throws on an unknown tool.
export async function callTool(
  h: DbHandles,
  embedder: Embedder,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const a = args;
  switch (name) {
    case 'store':
      return store(h, embedder, {
        content: String(a.content),
        source: a.source as string | undefined,
        observed: a.observed as string | undefined,
        date: a.date as string | undefined,
        tags: Array.isArray(a.tags) ? (a.tags as string[]) : undefined,
        meta: a.meta as Record<string, unknown> | undefined,
        supersedes: a.supersedes as number | undefined,
      });
    case 'query':
      return query(h, {
        source: a.source as string | undefined,
        observed: a.observed as string | undefined,
        tag: a.tag as string | undefined,
        since: a.since as string | undefined,
        until: a.until as string | undefined,
        liveOnly: a.live_only as boolean | undefined,
        limit: a.limit as number | undefined,
      });
    case 'recall':
      return recall(h, embedder, String(a.text), (a.k as number) ?? 5);
    case 'recall_docs':
      return recallDocs(h, embedder, String(a.text), (a.k as number) ?? 5);
    case 'lexical':
      return lexical(h, String(a.text), (a.k as number) ?? 50);
    case 'reindex':
      return reindex(h, embedder, String(a.root));
    case 'export_range':
      return exportRange(h, String(a.since), String(a.until));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
