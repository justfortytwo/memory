# AGENTS.md

Guidance for AI coding agents working in `@justfortytwo/memory`.

## What this is

A standalone, persona-agnostic **semantic-memory MCP server** (npm: `@justfortytwo/memory`,
bin `fortytwo-memory`). It stores text memories with free-form provenance and recalls them
semantically (sqlite-vec), lexically (FTS5), or by structured filter. Storage is SQLite via
`better-sqlite3` + `knex`. Embeddings come from Ollama by default, an opt-in OpenAI-compatible
provider, or a deterministic `FakeEmbedder` when `EMBED_MODEL` is unset. It is also a Claude Code
plugin (`.claude-plugin/plugin.json` + `.mcp.json`) and a library imported by sibling packages.

## Layout

```
src/
  index.ts               bin entry + public library re-exports (server boot guarded by invokedAsBin())
  server.ts              MCP Server: ListTools/CallTool + INSTRUCTIONS text sent on initialize
  tools.ts               MCP wire schema for the tool surface (toolDefinitions)
  dispatch.ts            callTool(): routes tool name+args to memory.ts (transport-free, unit-testable)
  contract.ts            MEMORY_TOOL_CONTRACT_VERSION, memoryToolContract, MEMORY_SERVER_ID
  memory.ts              core ops: store/query/recall/recallDocs/lexical/reindex/exportRange/reembed/deleteByIds
  embedder.ts            Embedder interface, FakeEmbedder, OllamaEmbedder, OpenAICompatEmbedder, embedderFromEnv
  db.ts                  openDb(): raw better-sqlite3 handle (+ sqlite-vec, vec0 tables) and a knex handle; EMBED_DIM=1024
  migrate.ts             runMigrations() with a static migration list; also the `npm run migrate` entry
  migrations/00N_*.ts    001_init, 002_fts, 003_approvals, 004_jobs
  enrichment.ts          enrich / enrichFromTurn (dedupe + write; salience extractor is injected)
  jobs.ts                durable jobs queue (enqueue/claimDue/complete/fail/requeueStale/...) used by scheduler
  gate-approval-store.ts GateApprovalStore: SQLite impl of @justfortytwo/gate's ApprovalStore + AuditLogger
test/*.test.ts           vitest suites (one per module, plus gate-seam cross-package test)
.github/workflows/ci.yml calls the shared justfortytwo/.github node-ci.yml workflow with siblings: "gate"
```

## Commands (from package.json)

```bash
npm run build       # tsc -> dist/
npm test            # vitest run (test/**/*.test.ts, 15s timeout)
npm run test:watch  # vitest
npm run migrate     # node dist/migrate.js  (needs a build first; uses DB_PATH or ./memory.db)
npm start           # node dist/index.js    (MCP server over stdio)
```

There is no lint or format script. Node >= 20. `prepublishOnly` runs the build.

## Environment

See `.env.example`. `DB_PATH` (default `./memory.db`), `EMBED_MODEL` (unset = FakeEmbedder),
`OLLAMA_BASE_URL` (default `http://localhost:11434`), `EMBED_PROVIDER` (`ollama` | `openai`),
`EMBED_API_KEY`, `EMBED_BASE_URL`. Never commit `.env` or `*.db` (gitignored).

## Conventions

- TypeScript, strict, ESM with `module`/`moduleResolution: NodeNext`: relative imports **must**
  use the `.js` extension (e.g. `import { openDb } from './db.js'`), including in tests.
- Tests import from `../src/*.js` and create temp DBs via `mkdtempSync(tmpdir())`; use
  `FakeEmbedder` rather than a live model.
- Commit style: conventional-ish with scope, e.g. `feat(memory): ...`, `docs(memory): ...`,
  releases as `release: memory 0.1.x — ...`.
- New public API must be re-exported from `src/index.ts`.

## Architecture notes and invariants

- **Tool surface is a versioned contract.** When changing tools, keep these four in sync:
  `src/tools.ts` (wire schema), `src/dispatch.ts` (routing), `src/contract.ts`
  (`memoryToolContract`), and the `INSTRUCTIONS` text in `src/server.ts` (keep it short; hosts
  may truncate). Breaking change to a tool name, required input, or result shape => bump
  `MEMORY_TOOL_CONTRACT_VERSION`. Additive changes do not bump it.
- Server id is `fortytwo-memory`; consumers call `mcp__fortytwo-memory__<tool>`.
- **Two DB handles.** vec0 virtual tables (`memory_vec`, `doc_vec`) are created on the raw
  handle in `openDb()` because sqlite-vec is loaded only there; knex migrations cannot create
  them. Relational schema and FTS5 live in knex migrations.
- **Migrations** are a static import list in `migrate.ts` tracked in `_migration_state`. Add a
  new `src/migrations/00N_name.ts` exporting `up`/`down` and append it to `MIGRATIONS`. No knex CLI.
- `src/index.ts` must not open a DB or start a transport on import: siblings import it as a
  library. The server only boots when run as the bin (realpath check).
- `supersedes` keeps history; never silently overwrite memories.
- `deleteByIds` is deliberately a **library API, not an MCP tool** (prompt-injection safety).
  Do not expose deletion as a tool.
- Vector dimension is fixed at 1024 (`EMBED_DIM`). Remote models are restricted to a
  1024-dim allowlist in `embedder.ts`. Switching models on an existing DB silently degrades
  recall until memories are re-embedded (`reembed`) and docs re-`reindex`ed.
- Enrichment owns only dedupe + write; the model-driven salience extractor is injected
  (from `@justfortytwo/salience`).

## Gotchas

- `knex` is CommonJS: `db.ts` uses `import knexPkg from 'knex'; const { knex } = knexPkg;`.
  A named `{ knex }` import passes under vitest but throws under raw `node dist/...`. Keep it.
- `@justfortytwo/gate` is an optional **peer** dependency, not a devDependency, yet
  `src/gate-approval-store.ts` imports its types and `test/gate-seam.test.ts` imports its
  runtime (`parseManifest`, `decide`). Build and tests need gate resolvable; CI provides it via
  `siblings: "gate"`. Locally, make the sibling `../gate` available (e.g. built and linked).
- `better-sqlite3` is native; unsupported Node/platform combos compile from source.
- README mentions `RUN_OLLAMA_TESTS=1` for a live-Ollama test, but no test in `test/` currently
  reads that variable.
- `.claude-plugin/plugin.json` version (0.1.0) is independent of `package.json` version.

## Sibling repos (`../`)

Each sibling is its own git repo / npm package under `@justfortytwo/*`:
- `gate` (safety gate; memory implements its ApprovalStore seam, one-way memory -> gate),
  `salience` (salience extractor, optional peer).
- Consumers of memory: `scheduler` (drains the `jobs` queue), `telegram`, `installer`
  (e.g. its `forget` command selects ids for `deleteByIds`).
- Others present: `persona`, `runner`, `marketplace`, `website`, `docs`.

Only edit this repo unless a task explicitly spans siblings.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.
