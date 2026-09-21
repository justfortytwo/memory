import { EMBED_DIM } from './db.js';

export type Vec = Float32Array;

export interface Embedder {
  embed(text: string): Promise<Vec>;
}

export function vecToBuffer(v: Vec): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Deterministic, dependency-free embedder for hermetic unit tests. */
export class FakeEmbedder implements Embedder {
  constructor(private dim = 1024) {}
  async embed(text: string): Promise<Vec> {
    const v = new Float32Array(this.dim);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    for (let i = 0; i < this.dim; i++) {
      h = Math.imul(h ^ (h >>> 13), 16777619);
      v[i] = (h >>> 0) % 1000 / 1000;
    }
    return v;
  }
}

/** Calls an Ollama /api/embeddings endpoint (local or remote). */
export class OllamaEmbedder implements Embedder {
  constructor(
    private model = 'qwen3-embedding:0.6b',
    private baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  ) {}
  async embed(text: string): Promise<Vec> {
    // Strip a trailing slash so a base URL like `https://host/` doesn't yield `host//api/...`.
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embedding: number[] };
    return Float32Array.from(json.embedding);
  }
}

/**
 * Remote models allowed with `EMBED_PROVIDER=openai`: every one emits (or can be
 * truncated to) EMBED_DIM, which the vec0 tables are fixed to. `sendDimensions`
 * asks the API to truncate (OpenAI's Matryoshka `dimensions` param); models that
 * are natively EMBED_DIM long must not be sent it.
 */
export const KNOWN_1024_MODELS: Readonly<Record<string, { sendDimensions: boolean; defaultBaseUrl?: string }>> = {
  'text-embedding-3-small': { sendDimensions: true, defaultBaseUrl: 'https://api.openai.com/v1' },
  'text-embedding-3-large': { sendDimensions: true, defaultBaseUrl: 'https://api.openai.com/v1' },
  'voyage-3-large': { sendDimensions: false, defaultBaseUrl: 'https://api.voyageai.com/v1' },
  // Self-hosted (e.g. vLLM): the model must be served under this exact name.
  'BAAI/bge-m3': { sendDimensions: false },
  'Qwen/Qwen3-Embedding-0.6B': { sendDimensions: false },
};

/** Calls an OpenAI-compatible `POST <baseUrl>/embeddings` endpoint. */
export class OpenAICompatEmbedder implements Embedder {
  constructor(
    private opts: { model: string; baseUrl: string; apiKey?: string; sendDimensions?: boolean },
  ) {}
  async embed(text: string): Promise<Vec> {
    const { model, baseUrl, apiKey, sendDimensions } = this.opts;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const body: Record<string, unknown> = { model, input: text };
    if (sendDimensions) body.dimensions = EMBED_DIM;
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Remote embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const vec = Float32Array.from(json.data[0].embedding);
    if (vec.length !== EMBED_DIM) {
      throw new Error(
        `${model} returned a ${vec.length}-dim vector but the store is fixed at ${EMBED_DIM}. ` +
          `Use a ${EMBED_DIM}-dim model from the allowlist.`,
      );
    }
    return vec;
  }
}

/**
 * Pick the embedder from env. Existing configs (EMBED_MODEL [+ OLLAMA_BASE_URL])
 * stay on Ollama; no EMBED_MODEL stays on FakeEmbedder. `EMBED_PROVIDER=openai`
 * opts in to a remote OpenAI-compatible model from KNOWN_1024_MODELS.
 */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder {
  const provider = env.EMBED_PROVIDER ?? 'ollama';
  if (provider !== 'ollama' && provider !== 'openai') {
    throw new Error(`Unknown EMBED_PROVIDER "${provider}" (expected "ollama" or "openai")`);
  }
  const model = env.EMBED_MODEL;
  if (provider === 'ollama') {
    return model ? new OllamaEmbedder(model, env.OLLAMA_BASE_URL) : new FakeEmbedder();
  }
  if (!model) throw new Error('EMBED_PROVIDER=openai requires EMBED_MODEL');
  if (!Object.hasOwn(KNOWN_1024_MODELS, model)) {
    throw new Error(
      `EMBED_MODEL "${model}" is not in the ${EMBED_DIM}-dim allowlist for EMBED_PROVIDER=openai. ` +
        `Accepted: ${Object.keys(KNOWN_1024_MODELS).join(', ')}`,
    );
  }
  const known = KNOWN_1024_MODELS[model];
  const baseUrl = env.EMBED_BASE_URL ?? known.defaultBaseUrl;
  if (!baseUrl) throw new Error(`EMBED_BASE_URL is required for ${model}`);
  return new OpenAICompatEmbedder({ model, baseUrl, apiKey: env.EMBED_API_KEY, sendDimensions: known.sendDimensions });
}
