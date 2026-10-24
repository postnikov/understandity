import {
  EngineError,
  TextRequestSchema,
  type AdapterFactory,
  type ProviderModule,
  type TextAdapter,
  type TextStreamEvent,
} from '@understandity/contracts';

/**
 * Cloud text engine: Anthropic Messages API with SSE streaming over plain fetch (no SDK, no new npm dependency).
 * Online profile only — EngineHub refuses it in Offline. The key is read from the env named in `secretEnv`
 * at call time (process env or the server's local key file); it never appears in errors or logs.
 *
 * Current models (Opus 5.5 / Sonnet 5.5) reject `temperature`, and thinking cannot be turned off on Opus 5.5:
 * latency is controlled with `output_config.effort` from config (`effort`, `courseEffort`).
 */

interface SseEvent {
  event: string;
  data: string;
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1]?.trim() ?? 'message';
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) yield { event, data };
    }
  }
}

export const createAnthropicText: AdapterFactory<'text'> = (config, { providerId }): TextAdapter => {
  const err = (code: ConstructorParameters<typeof EngineError>[0], message: string, retryable?: boolean) =>
    new EngineError(code, message, { modality: 'text', provider: providerId, ...(retryable === undefined ? {} : { retryable }) });
  const opt = config.options;
  const str = (k: string, d: string) => (typeof opt[k] === 'string' ? (opt[k] as string) : d);
  const num = (k: string, d: number) => (typeof opt[k] === 'number' ? (opt[k] as number) : d);
  const key = () => (config.secretEnv ? process.env[config.secretEnv] : undefined);

  return {
    modality: 'text',
    provider: providerId,
    locality: config.locality,
    heavy: false,
    async health() {
      // No paid probe: readiness is "key configured", not "API reachable".
      const set = !!key();
      return {
        state: set ? 'degraded' : 'down',
        detail: set ? 'key configured; live access is checked on first call' : `${config.secretEnv} is not set`,
        loadedModel: null,
        checkedAt: new Date().toISOString(),
      };
    },
    async listModels() {
      return config.models.map((id) => ({ id, installed: !!key() }));
    },
    capabilities() {
      return { streaming: true, audioInput: false, maxContextTokens: 1_000_000, languages: ['en', 'ru', 'es', 'ca'] };
    },
    async *stream(input, opts): AsyncIterable<TextStreamEvent> {
      const req = TextRequestSchema.parse(input);
      if (!config.models.includes(req.model)) throw err('model_missing', `model ${req.model} is not configured`);
      const apiKey = key();
      if (!apiKey) throw err('unavailable', `${config.secretEnv} is not set`, false);
      if (!config.endpoint) throw err('unavailable', 'endpoint is not configured');

      const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
      const isCourse = req.context?.purpose === 'course';
      const effort = isCourse ? str('courseEffort', 'medium') : str('effort', 'low');
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': str('apiVersion', '2023-06-01'),
      };
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: Math.max(req.maxTokens, num(isCourse ? 'courseMaxTokens' : 'minMaxTokens', 1024)),
        stream: true,
        messages,
        output_config: { effort },
        ...(system ? { system } : {}),
      };
      if (opt.fallbacks === 'default') {
        // Server-side refusal fallback (opt-in default for current models): the API reroutes a declined request.
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
        body.fallbacks = 'default';
      }

      const t0 = Date.now();
      const timeout = AbortSignal.timeout(num(isCourse ? 'courseTimeoutMs' : 'timeoutMs', 60_000));
      const signal = opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await fetch(new URL('/v1/messages', config.endpoint), { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error' });
      } catch (e) {
        if (opts?.signal?.aborted) throw err('cancelled', 'request cancelled');
        if (timeout.aborted) throw err('timeout', 'Anthropic request timed out');
        throw err('unavailable', 'Anthropic API not reachable');
      }
      if (!res.ok || !res.body) {
        // Never surface the provider body: it may echo the request (child answers) or headers.
        await res.body?.cancel();
        const s = res.status;
        const code = s === 429 || s === 529 ? 'busy' : s === 400 || s === 413 ? 'bad_input' : s === 404 ? 'model_missing' : 'unavailable';
        throw err(code, `Anthropic HTTP ${s}`, s === 401 || s === 403 ? false : undefined);
      }

      let text = '';
      let model = req.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let stop: string | null = null;
      for await (const ev of sse(res.body)) {
        if (ev.event === 'ping') continue;
        let data: Record<string, any>;
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (ev.event === 'error' || data.type === 'error') throw err('unavailable', `Anthropic stream error: ${data.error?.type ?? 'unknown'}`);
        if (data.type === 'message_start') {
          model = data.message?.model ?? model;
          inputTokens = data.message?.usage?.input_tokens;
        } else if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
          text += data.delta.text;
          yield { type: 'delta', text: data.delta.text };
        } else if (data.type === 'message_delta') {
          stop = data.delta?.stop_reason ?? stop;
          outputTokens = data.usage?.output_tokens ?? outputTokens;
        }
      }
      if (stop === 'refusal') throw err('unsupported', 'the model declined this request', false);
      yield { type: 'done', text, model, usage: { inputTokens, outputTokens, totalMs: Date.now() - t0 } };
    },
  };
};

export const textAnthropic: ProviderModule<'text'> = { modality: 'text', providerId: 'anthropic', create: createAnthropicText };
