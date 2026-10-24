import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@understandity/contracts';
import { createAnthropicText } from '../src/index.js';

const ENV = 'UD_TEST_ANTHROPIC_KEY';
const config: ProviderConfig = {
  enabled: false, locality: 'cloud', label: 'Claude', endpoint: 'https://api.anthropic.test',
  models: ['claude-opus-5-5', 'claude-sonnet-5-5'], voices: [], secretEnv: ENV,
  options: { effort: 'low', courseEffort: 'medium', minMaxTokens: 1024, fallbacks: 'default' },
};

function sseBody(events: Array<[string, unknown]>) {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new ReadableStream({
    start(c) {
      // split mid-event to exercise buffering
      const enc = new TextEncoder().encode(text);
      c.enqueue(enc.slice(0, 37));
      c.enqueue(enc.slice(37));
      c.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[ENV];
});

describe('anthropic text engine (mocked fetch)', () => {
  it('streams text deltas, sends no temperature, key only in x-api-key', async () => {
    process.env[ENV] = 'test-key-not-real';
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.temperature).toBeUndefined();
      expect(body.stream).toBe(true);
      expect(body.system).toBe('be brief');
      expect(body.output_config).toEqual({ effort: 'low' });
      expect(body.fallbacks).toBe('default');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key-not-real');
      return new Response(sseBody([
        ['message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 12 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
        ['ping', { type: 'ping' }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'VERDICT: partial\nYes. ' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Why?' } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
        ['message_stop', { type: 'message_stop' }],
      ]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const engine = createAnthropicText(config, { providerId: 'anthropic' });
    const deltas: string[] = [];
    let done: { text: string; usage?: { outputTokens?: number } } | null = null;
    for await (const ev of engine.stream({ model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'It sinks' }], temperature: 0.3 })) {
      if (ev.type === 'delta') deltas.push(ev.text);
      else done = ev;
    }
    expect(deltas.join('')).toBe('VERDICT: partial\nYes. Why?');
    expect(done?.text).toBe('VERDICT: partial\nYes. Why?');
    expect(done?.usage?.outputTokens).toBe(9);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('course requests use course effort', async () => {
    process.env[ENV] = 'k';
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).output_config).toEqual({ effort: 'medium' });
      return new Response(sseBody([['message_stop', { type: 'message_stop' }]]), { status: 200 });
    }));
    const engine = createAnthropicText(config, { providerId: 'anthropic' });
    for await (const _ of engine.stream({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }], context: { purpose: 'course' } })) void _;
  });

  it('no key → explicit error before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const engine = createAnthropicText(config, { providerId: 'anthropic' });
    await expect(engine.stream({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await engine.health()).state).toBe('down');
  });

  it('HTTP error never leaks the provider body; 401 is not retryable', async () => {
    process.env[ENV] = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"echo of the child answer"}', { status: 401 })));
    const engine = createAnthropicText(config, { providerId: 'anthropic' });
    const e = await engine.stream({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'x' }] })[Symbol.asyncIterator]().next().catch((x) => x);
    expect(e.code).toBe('unavailable');
    expect(e.retryable).toBe(false);
    expect(String(e.message)).not.toMatch(/child answer/);
  });
});
