import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Wire schema for the generic memory tool surface. Keep in sync with
// contract.ts (memoryToolContract) — that file is the version-tracked
// human contract; this file is what the MCP ListTools handler returns.
export function toolDefinitions(): Tool[] {
  return [
    {
      name: 'store',
      description: 'Store a memory (content + free-form provenance) and embed it for recall. Set `supersedes` to replace a prior memory (history is kept; never a silent overwrite).',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          source: { type: 'string', description: 'Free-form provenance, e.g. owner, web, tool:foo.' },
          observed: { type: 'string', description: 'Free-form, e.g. stated, inferred, imported.' },
          date: { type: 'string', description: 'ISO date the memory pertains to. Defaults to today (UTC).' },
          tags: { type: 'array', items: { type: 'string' } },
          meta: { type: 'object', description: 'Arbitrary structured provenance.' },
          supersedes: { type: 'number', description: 'Id of a memory this one replaces.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'query',
      description: 'Structured query over the memory store (source/observed/tag/time). Returns live rows only unless live_only=false.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string' }, observed: { type: 'string' }, tag: { type: 'string' },
          since: { type: 'string' }, until: { type: 'string' },
          live_only: { type: 'boolean' }, limit: { type: 'number' },
        },
      },
    },
    {
      name: 'recall',
      description: 'Semantic top-k recall over the memory store by meaning.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, k: { type: 'number' } }, required: ['text'] },
    },
    {
      name: 'recall_docs',
      description: 'Semantic top-k recall over reindexed markdown documents (the doc_vec index built by reindex).',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, k: { type: 'number' } }, required: ['text'] },
    },
    {
      name: 'lexical',
      description: 'Full-text keyword search over the memory store (FTS5).',
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, k: { type: 'number' } }, required: ['text'] },
    },
    {
      name: 'reindex',
      description: 'Self-heal the doc recall index from a directory of markdown files. Pass the directory in `root`.',
      inputSchema: { type: 'object', properties: { root: { type: 'string' } }, required: ['root'] },
    },
    {
      name: 'export_range',
      description: 'Render a date range of memories to markdown (for debugging/export).',
      inputSchema: {
        type: 'object',
        properties: { since: { type: 'string' }, until: { type: 'string' } },
        required: ['since', 'until'],
      },
    },
  ];
}
