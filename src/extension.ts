import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DbHandles } from './db.js';
import type { Embedder } from './embedder.js';

/**
 * Seam for sibling packages to add MCP tools to the memory server without
 * memory depending on them. Extension tools are outside `memoryToolContract`.
 * `call` returns undefined when it does not own the tool name.
 */
export interface McpExtension {
  tools(): Tool[];
  call(name: string, args: Record<string, unknown>): Promise<unknown | undefined>;
  instructions?: string;
}

/**
 * Import each named package and build its extension via `createMcpExtension(h, embedder)`.
 * A failing or malformed module is logged to stderr and skipped; it never stops the server.
 */
export async function loadExtensions(
  names: string[],
  h: DbHandles,
  embedder: Embedder,
  importer: (name: string) => Promise<unknown> = (n) => import(n),
): Promise<McpExtension[]> {
  const out: McpExtension[] = [];
  for (const name of names) {
    try {
      const mod = (await importer(name)) as { createMcpExtension?: unknown } | null;
      if (typeof mod?.createMcpExtension !== 'function') {
        throw new Error('module does not export createMcpExtension');
      }
      out.push(await mod.createMcpExtension(h, embedder));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`fortytwo-memory: extension "${name}" skipped: ${msg}\n`);
    }
  }
  return out;
}
