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

/** Calls a local Ollama /api/embeddings endpoint. */
export class OllamaEmbedder implements Embedder {
  constructor(
    private model = 'qwen3-embedding:0.6b',
    private baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  ) {}
  async embed(text: string): Promise<Vec> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embedding: number[] };
    return Float32Array.from(json.embedding);
  }
}
