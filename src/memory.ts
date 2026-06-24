import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import type { DbHandles } from './db.js';
import type { Embedder } from './embedder.js';
import { vecToBuffer } from './embedder.js';

// ---------------------------------------------------------------------------
// Generic semantic memory store.
//
// This is the persona-agnostic core extracted from fortytwo/services/memory-mcp.
// What was stripped (persona-specific, NOT brought into this package):
//   - the `journal_entries` schema (channel/direction/actor/approval_status)
//     and OWNER_ACTOR/ASSISTANT_ACTOR coupling — replaced by a generic
//     `memories` table keyed on `source` / `observed` / `date` / `tags`.
//   - the policy/authority/source-envelope machinery (policy.ts) — that is a
//     trust/prompt-injection concern owned elsewhere.
//     TODO(extract): if a shared trust model is wanted, it belongs in a sibling
//     package (e.g. `@justfortytwo/gate`), not here.
//   - the house-rules propose/approve learning loop, the pending-approval gate
//     (registry_pending), and the deferred-jobs runner (jobs.ts) — all original
//     assistant orchestration, out of scope for a standalone memory server.
// ---------------------------------------------------------------------------

/** A memory to write. `content` is required; everything else is provenance. */
export interface MemoryInput {
  content: string;
  /** Where this came from, e.g. "owner", "web", "tool:foo". Free-form. */
  source?: string;
  /** How it was observed, e.g. "stated", "inferred", "imported". Free-form. */
  observed?: string;
  /** ISO date the memory pertains to. Defaults to today (UTC) at write time. */
  date?: string;
  /** Free-form tags for filtering. */
  tags?: string[];
  /** Arbitrary structured provenance. Stored as JSON. */
  meta?: Record<string, unknown>;
  /**
   * If set, this memory SUPERSEDES the referenced memory id. The prior row is
   * kept (history is never silently destroyed) but flagged superseded.
   * See enrichment.ts for the dedupe/supersede design.
   */
  supersedes?: number | null;
}

export interface MemoryRow {
  id: number;
  ts: string;
  content: string;
  source: string | null;
  observed: string | null;
  date: string | null;
  tags: string;
  meta: string;
  superseded_by: number | null;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Atomic insert of the relational row + its embedding (raw transaction). */
export async function store(h: DbHandles, embedder: Embedder, m: MemoryInput): Promise<number> {
  const vec = vecToBuffer(await embedder.embed(m.content));
  const ins = h.raw.prepare(
    `INSERT INTO memories (content, source, observed, date, tags, meta)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insVec = h.raw.prepare('INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)');
  const markSuperseded = h.raw.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?');
  const txn = h.raw.transaction(() => {
    const info = ins.run(
      m.content,
      m.source ?? null,
      m.observed ?? null,
      m.date ?? todayUtc(),
      JSON.stringify(m.tags ?? []),
      JSON.stringify(m.meta ?? {}),
    );
    // vec0's xUpdate only accepts a 64-bit INTEGER binding; better-sqlite3
    // promotes BigInt to SQLITE_INTEGER, while a plain Number fails vec0's
    // "only integers allowed" check. Bind as BigInt; return as Number.
    const id = Number(info.lastInsertRowid);
    insVec.run(BigInt(id), vec);
    // SUPERSEDE: keep history, link the old row forward (never a silent overwrite).
    if (m.supersedes != null) markSuperseded.run(id, m.supersedes);
    return id;
  });
  return txn();
}

/**
 * Hard-delete memories by id. OWNER-PRIVILEGED: this is intentionally NOT an MCP
 * tool — the assistant must never be able to delete memories from (possibly
 * prompt-injected) content. Removes the row, its vector (memory_vec is not
 * trigger-backed, so clear it explicitly, one rowid at a time as vec0 wants),
 * and the FTS entry (handled by the memory_fts AFTER-DELETE trigger). Returns
 * the number of `memories` rows removed; missing ids are ignored.
 */
export function deleteByIds(h: DbHandles, ids: number[]): number {
  if (ids.length === 0) return 0;
  const delVec = h.raw.prepare('DELETE FROM memory_vec WHERE rowid = ?');
  const placeholders = ids.map(() => '?').join(', ');
  const delMem = h.raw.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`);
  const txn = h.raw.transaction((rowids: number[]) => {
    for (const id of rowids) delVec.run(BigInt(id)); // vec0 binds integers; point delete per rowid
    return Number(delMem.run(...rowids).changes); // FTS cleaned by the AFTER-DELETE trigger
  });
  return txn(ids);
}

export interface QueryOpts {
  source?: string;
  observed?: string;
  tag?: string;
  since?: string;
  until?: string;
  /** When false, superseded rows are excluded (default: true — only live rows). */
  liveOnly?: boolean;
  limit?: number;
}

export async function query(h: DbHandles, opts: QueryOpts = {}): Promise<MemoryRow[]> {
  let q = h.k<MemoryRow>('memories').select('*');
  if (opts.source) q = q.where('source', opts.source);
  if (opts.observed) q = q.where('observed', opts.observed);
  if (opts.tag) q = q.where('tags', 'like', `%"${opts.tag}"%`);
  if (opts.since) q = q.where('ts', '>=', opts.since);
  if (opts.until) q = q.where('ts', '<=', opts.until);
  if (opts.liveOnly !== false) q = q.whereNull('superseded_by');
  return q.orderBy('ts', 'desc').limit(opts.limit ?? 50);
}

export interface RecallRow extends MemoryRow {
  distance: number;
}

/** Semantic top-k recall over the memory store by meaning. */
export async function recall(h: DbHandles, embedder: Embedder, text: string, k = 5): Promise<RecallRow[]> {
  const qv = vecToBuffer(await embedder.embed(text));
  // sqlite-vec's vec0 module needs the KNN size constraint at prepare time.
  // `LIMIT ?` is only visible to vec0's xBestIndex on SQLite >= 3.41, so we
  // use the portable `k = ?` form in the WHERE clause instead.
  const stmt = h.raw.prepare(
    `SELECT m.*, v.distance
       FROM memory_vec v
       JOIN memories m ON m.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
        AND m.superseded_by IS NULL
      ORDER BY v.distance`,
  );
  return stmt.all(qv, k) as RecallRow[];
}

/** Full-text keyword search over the memory store (FTS5). */
export function lexical(h: DbHandles, text: string, k = 50): MemoryRow[] {
  const stmt = h.raw.prepare(
    `SELECT m.*
       FROM memory_fts f
       JOIN memories m ON m.id = f.rowid
      WHERE memory_fts MATCH ?
        AND m.superseded_by IS NULL
      ORDER BY rank
      LIMIT ?`,
  );
  // FTS5 MATCH treats spaces as AND; quote each token defensively.
  const safe = text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
  return stmt.all(safe, k) as MemoryRow[];
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function listMarkdown(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${root}/${f}`);
}

export interface ReindexResult { indexed: number; removed: number; }

/**
 * Self-heal the doc recall index from a directory of markdown files. Hashes
 * content to skip unchanged files; removes index rows for files that vanished.
 * Generic version of the original assistant's curated-doc reindex (no curated-corpus assumptions).
 */
export async function reindex(
  h: DbHandles,
  embedder: Embedder,
  root: string,
): Promise<ReindexResult> {
  const files = listMarkdown(root);
  const currentPaths = new Set(files);

  const selIndexed = h.raw.prepare('SELECT id, file_path FROM index_state');
  const selState = h.raw.prepare('SELECT id, sha256 FROM index_state WHERE file_path = ?');
  const insState = h.raw.prepare('INSERT INTO index_state (file_path, sha256) VALUES (?, ?)');
  const updState = h.raw.prepare(
    "UPDATE index_state SET sha256 = ?, embedded_at = datetime('now') WHERE id = ?",
  );
  const delState = h.raw.prepare('DELETE FROM index_state WHERE id = ?');
  const delVec = h.raw.prepare('DELETE FROM doc_vec WHERE rowid = ?');
  const insVec = h.raw.prepare('INSERT INTO doc_vec (rowid, embedding) VALUES (?, ?)');

  let indexed = 0;
  let removed = 0;
  for (const row of selIndexed.all() as Array<{ id: number; file_path: string }>) {
    if (currentPaths.has(row.file_path)) continue;
    const t = h.raw.transaction(() => {
      delVec.run(BigInt(row.id));
      delState.run(row.id);
    });
    t();
    removed++;
  }

  for (const path of files) {
    const content = readFileSync(path, 'utf8');
    const hash = sha256(content);
    const existing = selState.get(path) as { id: number; sha256: string } | undefined;
    if (existing && existing.sha256 === hash) continue;

    const vec = vecToBuffer(await embedder.embed(content));
    const t = h.raw.transaction(() => {
      let id: number;
      if (existing) {
        id = existing.id;
        updState.run(hash, id);
        delVec.run(BigInt(id));
      } else {
        const info = insState.run(path, hash);
        id = Number(info.lastInsertRowid);
      }
      // vec0's xUpdate only accepts a 64-bit INTEGER binding. Bind as BigInt.
      insVec.run(BigInt(id), vec);
    });
    t();
    indexed++;
  }
  return { indexed, removed };
}

export interface DocRecallRow {
  file_path: string;
  distance: number;
  preview: string;
}

/** Semantic top-k recall over reindexed markdown (the doc_vec index). */
export async function recallDocs(h: DbHandles, embedder: Embedder, text: string, k = 5): Promise<DocRecallRow[]> {
  const qv = vecToBuffer(await embedder.embed(text));
  const stmt = h.raw.prepare(
    `SELECT s.file_path, v.distance
       FROM doc_vec v
       JOIN index_state s ON s.id = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance`,
  );
  const rows = stmt.all(qv, k) as Array<{ file_path: string; distance: number }>;
  return rows.map((r) => {
    let preview = '';
    try { preview = readFileSync(r.file_path, 'utf8').slice(0, 200); } catch { /* removed since indexing */ }
    return { file_path: r.file_path, distance: r.distance, preview };
  });
}

/** Render a date range of memories to markdown (for debugging/export). */
export async function exportRange(h: DbHandles, since: string, until: string): Promise<string> {
  const rows = await h.k<MemoryRow>('memories')
    .whereBetween('ts', [`${since} 00:00:00`, `${until} 23:59:59`])
    .orderBy('ts', 'asc');
  if (rows.length === 0) return `# Memories — ${since}..${until}\n\n_(no entries)_\n`;
  const body = rows
    .map((r) => `### ${r.ts}${r.source ? ` · ${r.source}` : ''}${r.observed ? `/${r.observed}` : ''}\n\n${r.content}\n`)
    .join('\n');
  return `# Memories — ${since}..${until}\n\n${body}`;
}

/** Re-embed a stored memory's content (e.g. after an embedder/model change). */
export async function reembed(h: DbHandles, embedder: Embedder, id: number): Promise<boolean> {
  const row = await h.k<MemoryRow>('memories').select('content').where({ id }).first();
  if (!row) return false;
  const vec = vecToBuffer(await embedder.embed(row.content));
  const delVec = h.raw.prepare('DELETE FROM memory_vec WHERE rowid = ?');
  const insVec = h.raw.prepare('INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)');
  const txn = h.raw.transaction(() => {
    delVec.run(BigInt(id));
    insVec.run(BigInt(id), vec);
  });
  txn();
  return true;
}
