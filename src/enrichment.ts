import type { DbHandles } from './db.js';
import type { Embedder } from './embedder.js';
import { recall, store, type MemoryInput, type RecallRow } from './memory.js';
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
  _h: DbHandles,
  _embedder: Embedder,
  _candidates: EnrichmentCandidate[],
): Promise<EnrichmentResult> {
  // TODO(impl): implement the dedupe/supersede/write loop described above.
  //   for each candidate where salience >= SALIENCE_THRESHOLD:
  //     const near = await recall(_h, _embedder, candidate.content, 5);
  //     decide skip | write | write-and-supersede (see (2));
  //     await store(_h, _embedder, { ...candidate, supersedes });
  // Wired against memory.recall / memory.store; left unimplemented on purpose.
  void recall; void store; void ({} as MemoryInput); void ({} as RecallRow);
  throw new Error('enrichment.enrich is a stub — see TODO(impl) in enrichment.ts');
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
  _h: DbHandles,
  _embedder: Embedder,
  _turn: { text: string; source?: string },
  _extractor: SalienceExtractor,
): Promise<EnrichmentResult> {
  // TODO(wire): const candidates = await _extractor.extractSalient(_turn);
  //   (the extractor is @justfortytwo/deepthought's, with an injected LlmClient)
  // TODO(impl): return enrich(_h, _embedder, candidates);
  void _extractor;
  throw new Error('enrichment.enrichFromTurn is a stub — see TODO(wire) in enrichment.ts');
}
