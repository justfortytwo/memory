// ---------------------------------------------------------------------------
// Cross-package contract for @justfortytwo/guide.
//
// Siblings depend on this server through a STABLE tool surface, not its
// internals. The contract version is the coordination point:
//   - A MAJOR bump (breaking change to a tool name, its required inputs, or its
//     result shape) is a CONTRACT BREAK. Siblings pin a caret range on
//     @justfortytwo/guide; a major bump forces them to opt in.
//   - Additive changes (new optional inputs, new tools) do NOT bump the version.
//
// The MCP tools are namespaced by the registered server id "fortytwo-guide"
// (see .mcp.json), so a consumer calls them as `mcp__fortytwo-guide__<tool>`.
// ---------------------------------------------------------------------------

/** Bump on any breaking change to the tool surface below. */
export const GUIDE_TOOL_CONTRACT_VERSION = 1;

/** The MCP server id under which these tools are registered. */
export const GUIDE_SERVER_ID = 'fortytwo-guide';

/** Fully-qualified MCP tool names a consumer invokes. */
export const GUIDE_MCP_TOOLS = [
  'mcp__fortytwo-guide__store',
  'mcp__fortytwo-guide__query',
  'mcp__fortytwo-guide__recall',
  'mcp__fortytwo-guide__recall_docs',
  'mcp__fortytwo-guide__lexical',
  'mcp__fortytwo-guide__reindex',
  'mcp__fortytwo-guide__export_range',
] as const;

export type GuideMcpTool = (typeof GUIDE_MCP_TOOLS)[number];

/** Bare tool names (server-local, without the mcp__<server>__ prefix). */
export interface GuideToolSpec {
  /** Bare tool name as declared in the MCP ListTools response. */
  name: string;
  /** One-line human description of the tool's contract. */
  summary: string;
}

/**
 * Documented contract for each tool. Kept in sync with tools.ts (the wire
 * schema). This is the authoritative human-readable list siblings code against.
 */
export const guideToolContract: readonly GuideToolSpec[] = [
  { name: 'store', summary: 'Store a memory (content + free-form provenance) and embed it for recall. Supports SUPERSEDE.' },
  { name: 'query', summary: 'Structured query over the memory store (source/observed/tag/time, live-only by default).' },
  { name: 'recall', summary: 'Semantic top-k recall over the memory store by meaning.' },
  { name: 'recall_docs', summary: 'Semantic top-k recall over reindexed markdown documents (the doc_vec index).' },
  { name: 'lexical', summary: 'Full-text keyword search over the memory store (FTS5).' },
  { name: 'reindex', summary: 'Self-heal the doc recall index from a directory of markdown files.' },
  { name: 'export_range', summary: 'Render a date range of memories to markdown (for debugging/export).' },
] as const;
