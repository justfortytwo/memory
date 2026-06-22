import type { DbHandles } from './db.js';
import type { Embedder } from './embedder.js';
import { recall, store } from './memory.js';
// TODO(wire): the salience extractor lives in the @justfortytwo/deepthought peer.
//   import type { SalienceExtractor, Turn } from '@justfortytwo/deepthought';
// Local mirrors of deepthought's surface so this file type-checks before the peer
// is installed. The Candidate shape is intentionally identical to EnrichmentCandidate.
interface SalienceExtractor {
  extractSalient(turn: { text: string; source?: string; observed?: string; date?: string; meta?: Record<string, unknown> }): Promise<EnrichmentCandidate[]>;
}

// ===========================================================================
// Continuous enrichment — STUB.
//
// Goal: after each conversational turn, distil durable knowledge from the turn
// and fold it into the memory store WITHOUT ever silently destroying a prior
// belief. This is the write-side counterpart to recall: recall reads, enrichment
// curates what is worth remembering.
//
// PIPELINE (post-turn):
//
//   1. SALIENCE EXTRACTION
//      Take the turn (user + assistant text, tool results) and extract a small
//      set of candidate memories — atomic, self-contained statements worth
//      keeping ("the owner's child is named X", "the deploy script lives at Y").
//      Each candidate carries a salience score; below a threshold we drop it so
//      the store does not fill with noise.
//      The extractor is model-driven, and the LLM call is NOT owned by this
//      package (a memory server must not embed a model client). The salience
//      step lives in the sibling `@justfortytwo/deepthought` engine, which
//      defines a `SalienceExtractor` (injected `LlmClient`) and returns scored
//      candidates. We inject that extractor and pass its candidates IN to
//      enrich(); this file owns only dedupe + write.
//
//   2. DEDUPE / SUPERSEDE  (recency wins, history is kept, NEVER overwrite)
//      For each candidate, semantically recall the nearest existing memories.
//        - near-duplicate (distance below DEDUPE_DISTANCE) and same meaning:
//            skip the write — we already know this.
//        - contradiction / update of an existing belief:
//            write the new memory and SUPERSEDE the old row (memory.store with
//            `supersedes`). The old row is retained and flagged superseded_by,
//            so the history of what we believed and when is fully auditable.
//            Recency wins for live recall; nothing is deleted.
//      TODO(impl): "same meaning" vs "contradiction" needs more than vector
//        distance (two close vectors can be opposite facts). This likely needs
//        the same sibling deepthought step as (1) to judge the relation.
//
//   3. WRITE  (tagged provenance)
//      Persist surviving candidates via memory.store, tagged with:
//        - source:   where the knowledge came from (e.g. the channel/actor)
//        - observed: how we came to believe it (e.g. "stated" vs "inferred")
//        - date:     when it was observed
//      Inferred memories MUST be marked observed:"inferred" so downstream
//      consumers can weight stated facts over guesses.
//
// The contract: enrichment is ADDITIVE and AUDITABLE. A wrong inference can be
// superseded later; it is never silently erased.
// ===========================================================================

/** Below this vector distance two memories are treated as near-duplicates. */
export const DEDUPE_DISTANCE = 0.15;

/** Drop candidates whose salience is below this score. */
export const SALIENCE_THRESHOLD = 0.5;

/** A distilled candidate memory produced by an (external) salience extractor. */
export interface EnrichmentCandidate {
  content: string;
  salience: number; // 0..1
  source?: string;
  observed?: string; // "stated" | "inferred" | ...
  date?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  /**
   * If set, this candidate supersedes the given memory id — an upstream
   * contradiction/update judgment (e.g. from the deepthought salience step).
   * enrich() honors it: the new row is written and the old row is flagged
   * superseded (history kept, never overwritten), even past the dedupe check.
   */
  supersedes?: number | null;
}

export interface EnrichmentResult {
  written: number[];   // ids of newly stored memories
  superseded: number[]; // ids of memories superseded by this enrichment pass
  skipped: number;     // candidates dropped (low salience or duplicate)
}

/**
 * Fold a batch of candidate memories into the store: dedupe, supersede stale
 * beliefs (keeping history), and write the survivors with provenance.
 *
 * NOTE: candidates are produced UPSTREAM. This function owns dedupe + write
 * only — it does not call any model.
 */
export async function enrich(
  h: DbHandles,
  embedder: Embedder,
  candidates: EnrichmentCandidate[],
): Promise<EnrichmentResult> {
  const written: number[] = [];
  const superseded: number[] = [];
  let skipped = 0;

  for (const c of candidates) {
    if (c.salience < SALIENCE_THRESHOLD) {
      skipped++;
      continue;
    }
    // Dedupe by meaning — unless the candidate explicitly supersedes a prior row,
    // in which case the update is intentional even if it reads similar.
    if (c.supersedes == null) {
      const near = await recall(h, embedder, c.content, 1);
      if (near.length > 0 && near[0].distance < DEDUPE_DISTANCE) {
        skipped++;
        continue;
      }
    }
    const id = await store(h, embedder, {
      content: c.content,
      source: c.source,
      observed: c.observed,
      date: c.date,
      tags: c.tags,
      meta: c.meta,
      supersedes: c.supersedes ?? null,
    });
    written.push(id);
    if (c.supersedes != null) superseded.push(c.supersedes);
  }

  return { written, superseded, skipped };
}

/**
 * Post-turn entry point: extract salient candidates from a turn, then enrich.
 *
 * The extraction step is delegated to the sibling @justfortytwo/deepthought
 * engine via an INJECTED SalienceExtractor — guide owns dedupe + write, never the
 * model client. The host builds the extractor (deepthought's createSalienceExtractor
 * with its own LlmClient) and passes it in here.
 */
export async function enrichFromTurn(
  h: DbHandles,
  embedder: Embedder,
  turn: { text: string; source?: string },
  extractor: SalienceExtractor,
): Promise<EnrichmentResult> {
  // guide owns dedupe + write; the salience extraction (the model call) is the
  // injected @justfortytwo/deepthought engine's. We only wire the two together.
  const candidates = await extractor.extractSalient(turn);
  return enrich(h, embedder, candidates);
}
