import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, ProviderConfigSchema, collectText } from '@understandity/contracts';
import { createOllamaText } from '../src/index.js';

const config = ProviderConfigSchema.parse({
  locality: 'local',
  endpoint: 'http://127.0.0.1:11434',
  models: ['gemma4:12b-mlx', 'qwen3.8:27b-mlx'],
  options: { think: false, keepAlive: '10m' },
});
const adapter = () => createOllamaText(config, { providerId: 'ollama' });

function ndjson(lines: object[], status = 200) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      // split a line across chunks on purpose
      const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      c.enqueue(enc.encode(raw.slice(0, 17)));
      c.enqueue(enc.encode(raw.slice(17)));
      c.close();
    },
  });
  return new Response(body, { status });
}

afterEach(() => vi.unstubAllGlobals());

describe('text-ollama adapter', () => {
  it('streams /api/chat deltas and ends with done + usage; sends think, format, keep_alive, no num_ctx', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return ndjson([
        { model: 'gemma4:12b-mlx', message: { content: '{"a":' }, done: false },
        { model: 'gemma4:12b-mlx', message: { content: '1}' }, done: false },
        { model: 'gemma4:12b-mlx', message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5, load_duration: 2e9, total_duration: 3e9 },
      ]);
    });
    const res = await collectText(adapter().stream({ model: 'gemma4:12b-mlx', messages: [{ role: 'user', content: 'hi' }], json: true }));
    expect(res.text).toBe('{"a":1}');
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, loadMs: 2000, totalMs: 3000 });
    expect(calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]!.body).toMatchObject({ model: 'gemma4:12b-mlx', stream: true, think: false, format: 'json', keep_alive: '10m' });
    expect((calls[0]!.body.options as Record<string, unknown>).num_ctx).toBeUndefined();
  });

  it('refuses a model that is not in the config', async () => {
    const it = adapter().stream({ model: 'llama-whatever', messages: [{ role: 'user', content: 'x' }] });
    await expect(collectText(it)).rejects.toMatchObject({ code: 'model_missing' });
  });

  it('maps connection refused to unavailable and 404 to model_missing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(collectText(adapter().stream({ model: 'gemma4:12b-mlx', messages: [{ role: 'user', content: 'x' }] }))).rejects.toMatchObject({
      code: 'unavailable',
    });
    vi.stubGlobal('fetch', async () => new Response('{"error":"model \\"gemma4:12b-mlx\\" not found"}', { status: 404 }));
    const err = await collectText(adapter().stream({ model: 'gemma4:12b-mlx', messages: [{ role: 'user', content: 'x' }] })).catch((e) => e);
    expect(EngineError.is(err) && err.code).toBe('model_missing');
  });

  it('health and listModels read /api/tags; unload sends keep_alive 0', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'gemma4:12b-mlx', size: 7714091504 }] });
      if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'gemma4:12b-mlx' }] });
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ done: true });
    });
    const a = adapter();
    expect(a.heavy).toBe(true);
    const h = await a.health();
    expect(h).toMatchObject({ state: 'ok', loadedModel: 'gemma4:12b-mlx' });
    expect(h.detail).toMatch(/missing: qwen3.8:27b-mlx/);
    expect(await a.listModels()).toEqual([
      expect.objectContaining({ id: 'gemma4:12b-mlx', installed: true, sizeBytes: 7714091504 }),
      expect.objectContaining({ id: 'qwen3.8:27b-mlx', installed: false }),
    ]);
    await a.unload!('gemma4:12b-mlx');
    expect(posts).toEqual([{ url: 'http://127.0.0.1:11434/api/generate', body: { model: 'gemma4:12b-mlx', keep_alive: 0 } }]);
  });

  it('health is down when ollama is not reachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect((await adapter().health()).state).toBe('down');
  });
});
