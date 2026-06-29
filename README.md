# @justfortytwo/memory

A standalone **semantic-memory MCP server**. It stores text "memories" with
free-form provenance and recalls them by meaning (vector search), by keyword
(FTS5), or by structured filter. Backed by SQLite + [`sqlite-vec`], embeddings
from a local [Ollama] model.

It is **persona-agnostic**: no journal/persona/approval coupling, just a generic
memory store and tool surface. It can be used on its own, or as a Claude Code
plugin.

[`sqlite-vec`]: https://github.com/asg017/sqlite-vec
[Ollama]: https://ollama.com

## What it stores

A memory is `content` plus provenance:

| field | meaning |
|-------|---------|
| `content` | the text (embedded for recall) |
| `source` | where it came from — free-form (`owner`, `web`, `tool:foo`) |
| `observed` | how it was observed — free-form (`stated`, `inferred`, `imported`) |
| `date` | ISO date the memory pertains to (defaults to today, UTC) |
| `tags` | free-form tags for filtering |
| `supersedes` | id of a prior memory this one replaces (history is **kept**) |

Recall is hybrid: `recall` (semantic), `lexical` (FTS5 keyword), and `query`
(structured). `reindex` + `recall_docs` index/search a directory of markdown
documents separately from the memory store.

## MCP tools

The server registers under the id **`fortytwo-memory`**, so a consumer calls the
tools as `mcp__fortytwo-memory__<tool>`:

| tool | description |
|------|-------------|
| `store` | store a memory (+ provenance); set `supersedes` to replace one |
| `query` | structured query (source/observed/tag/time; live rows by default) |
| `recall` | semantic top-k recall by meaning |
| `recall_docs` | semantic recall over reindexed markdown |
| `lexical` | full-text keyword search (FTS5) |
| `reindex` | self-heal the doc index from a markdown directory |
| `export_range` | render a date range of memories to markdown |

### Contract version

Consumers depend on the **tool surface**, not the internals. The contract is
versioned:

```ts
import { MEMORY_TOOL_CONTRACT_VERSION, memoryToolContract } from '@justfortytwo/memory/contract';
```

- A **major** change to a tool name, its required inputs, or its result shape is
  a **contract break** → bump `MEMORY_TOOL_CONTRACT_VERSION`. Siblings pin a
  caret range on `@justfortytwo/memory`, so a major bump forces an explicit
  opt-in.
- Additive changes (new optional inputs, new tools) do **not** bump it.

`memoryToolContract` is the authoritative human-readable list of tools and their
guarantees, kept in sync with the wire schema in `src/tools.ts`.

## Embedder

The default embedder is **`OllamaEmbedder`**, which calls a local Ollama
`/api/embeddings` endpoint.

```bash
OLLAMA_BASE_URL=http://localhost:11434   # default
EMBED_MODEL=qwen3-embedding:0.6b         # default model (1024-dim)
```

Pull the model once:

```bash
ollama pull qwen3-embedding:0.6b
```

If `EMBED_MODEL` is **unset**, the server falls back to a deterministic,
dependency-free **`FakeEmbedder`** — useful for tests, CI, and first-run smoke
checks with zero infra. (The vector tables are fixed at 1024-dim; a model with a
different dimensionality requires a schema change.)

## Standalone usage

```bash
npm install @justfortytwo/memory
```

**Prerequisites.** Requires **Node.js >= 20**. The package depends on
[`better-sqlite3`] `^12`, a native module that ships prebuilt binaries for LTS
Node releases — on an unsupported Node version or platform, `npm install` will
compile it from source (needs a C/C++ toolchain). It also needs a local (or
remote) [Ollama] for real embeddings; without `EMBED_MODEL` set it falls back to
a deterministic `FakeEmbedder` (see [Embedder](#embedder)). `sqlite-vec` ships as
a bundled npm dependency — no manual SQLite-extension install is needed.

[`better-sqlite3`]: https://github.com/WiseLibs/better-sqlite3

```bash
# build (once); the server runs the built JS, not TS
npm run build

# apply migrations to the DB (DB_PATH or ./memory.db)
DB_PATH=./memory.db npm run migrate

# run the MCP server over stdio
DB_PATH=./memory.db EMBED_MODEL=qwen3-embedding:0.6b fortytwo-memory
```

The `bin` is `fortytwo-memory` → `dist/index.js`. You can also run it with
`npx -y @justfortytwo/memory` (it is published to npm).

### Register in your own `.mcp.json`

To use the server in any MCP host (not as a Claude Code plugin), drop this into
your project's `.mcp.json` with a real DB path:

```json
{
  "mcpServers": {
    "fortytwo-memory": {
      "command": "npx",
      "args": ["-y", "@justfortytwo/memory"],
      "env": {
        "DB_PATH": "./memory.db",
        "EMBED_MODEL": "qwen3-embedding:0.6b",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

`OLLAMA_BASE_URL` may point at a remote host. The embedder strips a trailing
slash, so either form works — but prefer no trailing slash.

### As a library

```ts
import { openDb, runMigrations, OllamaEmbedder, store, recall, deleteByIds } from '@justfortytwo/memory';

const h = openDb('memory.db');
await runMigrations(h.k);
const embedder = new OllamaEmbedder();

await store(h, embedder, { content: 'the deploy script lives in scripts/deploy.sh', source: 'owner', observed: 'stated' });
const hits = await recall(h, embedder, 'how do I deploy?', 5);

deleteByIds(h, [hits[0].id]); // hard-delete (row + vector + FTS); returns the count removed
```

### Deleting memories

`deleteByIds(h, ids)` hard-deletes memories — the row, its vector, and its FTS
entry — so nothing resurfaces in `recall`/`lexical`/`query`. It is intentionally
a **library API and NOT an MCP tool**: deletion is an owner-privileged operation,
and exposing it to the assistant's turn loop would let prompt-injected content
trick it into erasing memories. Selecting *which* ids to remove (by query, tag,
date range, …) is the caller's job — see `@justfortytwo/installer`'s `forget`.

## As a Claude Code plugin

`.claude-plugin/plugin.json` declares the plugin; `.mcp.json` registers the
`fortytwo-memory` server. By default it launches via `npx`:

```jsonc
{
  "mcpServers": {
    "fortytwo-memory": {
      "command": "npx",
      "args": ["-y", "@justfortytwo/memory"],
      "env": {
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "EMBED_MODEL": "qwen3-embedding:0.6b",
        "DB_PATH": "${CLAUDE_PLUGIN_DATA}/memory.db"
      }
    }
  }
}
```

`${CLAUDE_PLUGIN_DATA}` survives plugin updates, so the DB persists across
upgrades. When developing from source, build first (`npm run build`) and swap
the command to `node` with args `["${CLAUDE_PLUGIN_ROOT}/dist/index.js"]`.
Claude Code does **not** build MCP servers — they run via npm/npx.

## Continuous enrichment

`enrich(h, embedder, candidates)` folds a batch of candidate memories into the
store: it drops low-salience candidates, **dedupes** near-duplicates by meaning,
and writes the survivors with provenance — honoring an explicit `supersedes` to
replace a stale belief (history is kept, never a silent overwrite).
`enrichFromTurn(h, embedder, turn, extractor)` runs an injected `SalienceExtractor`
and feeds its candidates to `enrich`.

The salience extractor itself is model-driven and lives in the sibling
**`@justfortytwo/salience`** engine (a `SalienceExtractor` with an injected
`LlmClient`) — memory owns only the dedupe + write, never the model call.

## Peer seams

memory depends on two sibling packages **one-directionally** (declared as optional
peers, no cycle):

- **`@justfortytwo/gate`** — memory ships `GateApprovalStore`
  (`src/gate-approval-store.ts`), a durable SQLite-backed implementation of
  gate's `ApprovalStore` + `AuditLogger` interfaces. Pass it to gate's
  `decide(..., { store, audit })` to back the safety gate's one-shot approvals
  with memory's db instead of the gate's standalone JSONL store.
- **`@justfortytwo/salience`** — the model-driven salience extractor injected
  into `enrichFromTurn` (see above).

## Development

```bash
npm run build      # tsc
npm test           # vitest run
npm run test:watch # vitest
```

Set `RUN_OLLAMA_TESTS=1` to run the opt-in live-Ollama embedder test.

## License

MIT © 2026 Enrico Deleo

---

Created and maintained by [**Enrico Deleo**](https://enricodeleo.com).
