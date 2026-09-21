import { describe, it, expect, afterEach } from 'vitest';
import { FakeEmbedder, OllamaEmbedder, OpenAICompatEmbedder, embedderFromEnv } from '../src/embedder.js';
import { EMBED_DIM } from '../src/db.js';

// Capture the URL OllamaEmbedder passes to fetch (stubbed) so we can assert on
// how the request URL is constructed, independent of any running Ollama.
describe('OllamaEmbedder URL construction', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function capture(baseUrl: string): Promise<string> {
    let called = '';
    globalThis.fetch = (async (url: unknown) => {
      called = String(url);
      return { ok: true, json: async () => ({ embedding: [0, 1, 2] }) } as Response;
    }) as typeof fetch;
    await new OllamaEmbedder('qwen3-embedding:0.6b', baseUrl).embed('hi');
    return called;
  }

  it('does not double the slash when the base url has a trailing slash', async () => {
    expect(await capture('https://ollama.lab.example.com/')).toBe(
      'https://ollama.lab.example.com/api/embeddings',
    );
  });

  it('builds the same url whether or not the base url has a trailing slash', async () => {
    expect(await capture('http://localhost:11434')).toBe('http://localhost:11434/api/embeddings');
  });
});

// --- OpenAI-compatible remote embedder ---------------------------------------

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function stubFetch(embeddingLen = EMBED_DIM): Captured {
  const cap: Captured = { url: '', headers: {}, body: {} };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    cap.url = String(url);
    cap.headers = (init?.headers ?? {}) as Record<string, string>;
    cap.body = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () => ({ data: [{ embedding: new Array(embeddingLen).fill(0.5) }] }),
    } as Response;
  }) as typeof fetch;
  return cap;
}

describe('OpenAICompatEmbedder', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('posts {model, input} to <baseUrl>/embeddings with a bearer token and returns the vector', async () => {
    const cap = stubFetch();
    const e = new OpenAICompatEmbedder({ model: 'BAAI/bge-m3', baseUrl: 'https://vllm.example.com/v1', apiKey: 'sk-test' });
    const v = await e.embed('hello');
    expect(cap.url).toBe('https://vllm.example.com/v1/embeddings');
    expect(cap.headers.authorization).toBe('Bearer sk-test');
    expect(cap.body).toEqual({ model: 'BAAI/bge-m3', input: 'hello' });
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
  });

  it('does not double the slash when the base url has a trailing slash', async () => {
    const cap = stubFetch();
    await new OpenAICompatEmbedder({ model: 'm', baseUrl: 'https://host/v1/' }).embed('x');
    expect(cap.url).toBe('https://host/v1/embeddings');
  });

  it('omits the Authorization header when no api key is given (self-hosted)', async () => {
    const cap = stubFetch();
    await new OpenAICompatEmbedder({ model: 'm', baseUrl: 'https://host/v1' }).embed('x');
    expect(cap.headers).not.toHaveProperty('authorization');
  });

  it('sends dimensions pinned to EMBED_DIM only when sendDimensions is set', async () => {
    const withDims = stubFetch();
    await new OpenAICompatEmbedder({ model: 'm', baseUrl: 'https://h/v1', sendDimensions: true }).embed('x');
    expect(withDims.body.dimensions).toBe(EMBED_DIM);

    const without = stubFetch();
    await new OpenAICompatEmbedder({ model: 'm', baseUrl: 'https://h/v1' }).embed('x');
    expect(without.body).not.toHaveProperty('dimensions');
  });

  it('throws with the status and body on a non-2xx response', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 401, text: async () => 'bad key' }) as Response) as typeof fetch;
    await expect(new OpenAICompatEmbedder({ model: 'm', baseUrl: 'https://h/v1' }).embed('x')).rejects.toThrow(
      /401.*bad key/s,
    );
  });

  it('throws naming the model and both lengths when the vector is not EMBED_DIM long', async () => {
    stubFetch(1536);
    await expect(
      new OpenAICompatEmbedder({ model: 'text-embedding-3-small', baseUrl: 'https://h/v1' }).embed('x'),
    ).rejects.toThrow(/text-embedding-3-small.*1536.*1024/s);
  });
});

describe('embedderFromEnv', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('falls back to FakeEmbedder when EMBED_MODEL is unset', () => {
    expect(embedderFromEnv({})).toBeInstanceOf(FakeEmbedder);
  });

  it('keeps existing configs on Ollama (EMBED_MODEL only, or explicit ollama)', () => {
    expect(embedderFromEnv({ EMBED_MODEL: 'qwen3-embedding:0.6b' })).toBeInstanceOf(OllamaEmbedder);
    expect(embedderFromEnv({ EMBED_PROVIDER: 'ollama', EMBED_MODEL: 'anything' })).toBeInstanceOf(OllamaEmbedder);
  });

  it('builds an OpenAI embedder for a known model, defaulting base url and sending dimensions', async () => {
    const cap = stubFetch();
    const e = embedderFromEnv({ EMBED_PROVIDER: 'openai', EMBED_MODEL: 'text-embedding-3-small', EMBED_API_KEY: 'sk-x' });
    expect(e).toBeInstanceOf(OpenAICompatEmbedder);
    await e.embed('hi');
    expect(cap.url).toBe('https://api.openai.com/v1/embeddings');
    expect(cap.headers.authorization).toBe('Bearer sk-x');
    expect(cap.body.dimensions).toBe(EMBED_DIM);
  });

  it('uses the voyage default base url and does not send dimensions', async () => {
    const cap = stubFetch();
    await embedderFromEnv({ EMBED_PROVIDER: 'openai', EMBED_MODEL: 'voyage-3-large' }).embed('hi');
    expect(cap.url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(cap.body).not.toHaveProperty('dimensions');
  });

  it('requires EMBED_BASE_URL for self-hosted models, and honours it when set', async () => {
    expect(() => embedderFromEnv({ EMBED_PROVIDER: 'openai', EMBED_MODEL: 'BAAI/bge-m3' })).toThrow(/EMBED_BASE_URL/);
    const cap = stubFetch();
    await embedderFromEnv({
      EMBED_PROVIDER: 'openai',
      EMBED_MODEL: 'BAAI/bge-m3',
      EMBED_BASE_URL: 'http://vllm:8000/v1',
    }).embed('hi');
    expect(cap.url).toBe('http://vllm:8000/v1/embeddings');
  });

  it('rejects a model outside the 1024-dim allowlist and lists the accepted ones', () => {
    expect(() => embedderFromEnv({ EMBED_PROVIDER: 'openai', EMBED_MODEL: 'mistral-embed' })).toThrow(
      /mistral-embed.*text-embedding-3-small.*BAAI\/bge-m3/s,
    );
  });

  it('throws when the openai provider is chosen without EMBED_MODEL (no silent fake)', () => {
    expect(() => embedderFromEnv({ EMBED_PROVIDER: 'openai' })).toThrow(/EMBED_MODEL/);
  });

  it('throws on an unknown provider', () => {
    expect(() => embedderFromEnv({ EMBED_PROVIDER: 'nope', EMBED_MODEL: 'm' })).toThrow(/EMBED_PROVIDER.*nope/s);
  });
});
