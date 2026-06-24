import { describe, it, expect, afterEach } from 'vitest';
import { OllamaEmbedder } from '../src/embedder.js';

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
