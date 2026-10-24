import {
  EngineError,
  TextRequestSchema,
  type AdapterFactory,
  type CallOptions,
  type HealthStatus,
  type ModelInfo,
  type ProviderConfig,
  type ProviderModule,
  type TextAdapter,
  type TextStreamEvent,
} from '@understandity/contracts';

/**
 * Local text engine: Ollama `/api/chat` with streaming (NDJSON).
 * Models, endpoint, keep-alive and context size come from `config/engines.json` — nothing is hard-coded here.
 * Heavy: the dispatcher unloads it (`keep_alive: 0`) before another heavy engine takes the machine.
 */

interface OllamaOptions {
  think: boolean;
  keepAlive: string | number | null;
  /** Sent only when set: changing context size forces Ollama to reload the model. */
  numCtx: number | null;
  /** Health/tags probe timeout. */
  probeTimeoutMs: number;
  maxContextTokens: number;
  languages: string[];
}

function readOptions(config: ProviderConfig): OllamaOptions {
  const o = config.options;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    think: o.think === true,
    keepAlive: typeof o.keepAlive === 'string' || typeof o.keepAlive === 'number' ? o.keepAlive : null,
    numCtx: num(o.numCtx),
    probeTimeoutMs: num(o.probeTimeoutMs) ?? 3000,
    maxContextTokens: num(o.contextWindow) ?? 32768,
    languages: Array.isArray(o.languages) ? o.languages.map(String) : ['en', 'ru', 'es', 'ca'],
  };
}

interface OllamaTag {
  name: string;
  model?: string;
  size?: number;
}

interface OllamaChatChunk {
  model?: string;
  message?: { role?: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  total_duration?: number;
}

const nsToMs = (ns: number | undefined) => (typeof ns === 'number' ? ns / 1e6 : undefined);

export const createOllamaText: AdapterFactory<'text'> = (config, { providerId }): TextAdapter => {
  const opts = readOptions(config);
  const base = (config.endpoint ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const err = (code: ConstructorParameters<typeof EngineError>[0], message: string, cause?: unknown) =>
    new EngineError(code, message, { modality: 'text', provider: providerId, cause });

  async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const signals = [init.signal, init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined].filter(Boolean) as AbortSignal[];
    try {
      return await fetch(`${base}${path}`, { ...init, signal: signals.length ? AbortSignal.any(signals) : undefined });
    } catch (e) {
      if (init.signal?.aborted) throw err('cancelled', `ollama ${path}: cancelled`, e);
      if (e instanceof DOMException && e.name === 'TimeoutError') throw err('timeout', `ollama ${path}: timed out`, e);
      throw err('unavailable', `ollama not reachable at ${base}`, e);
    }
  }

  async function tags(callOpts?: CallOptions): Promise<OllamaTag[]> {
    const res = await call('/api/tags', { signal: callOpts?.signal, timeoutMs: opts.probeTimeoutMs });
    if (!res.ok) throw err('unavailable', `ollama /api/tags: HTTP ${res.status}`);
    const body = (await res.json()) as { models?: OllamaTag[] };
    return body.models ?? [];
  }

  async function loaded(callOpts?: CallOptions): Promise<string | null> {
    const res = await call('/api/ps', { signal: callOpts?.signal, timeoutMs: opts.probeTimeoutMs });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: OllamaTag[] };
    const mine = (body.models ?? []).find((m) => config.models.includes(m.name));
    return mine?.name ?? body.models?.[0]?.name ?? null;
  }

  return {
    modality: 'text',
    provider: providerId,
    locality: config.locality,
    heavy: true,

    async health(callOpts): Promise<HealthStatus> {
      const started = Date.now();
      const checkedAt = new Date().toISOString();
      try {
        const installed = new Set((await tags(callOpts)).map((t) => t.name));
        const present = config.models.filter((m) => installed.has(m));
        const loadedModel = await loaded(callOpts).catch(() => null);
        const latencyMs = Date.now() - started;
        if (present.length === 0) {
          return { state: 'degraded', detail: `none of the configured models installed: ${config.models.join(', ')}`, loadedModel, checkedAt, latencyMs };
        }
        const missing = config.models.filter((m) => !installed.has(m));
        return {
          state: 'ok',
          detail: missing.length ? `missing: ${missing.join(', ')}` : `models: ${present.join(', ')}`,
          loadedModel,
          checkedAt,
          latencyMs,
        };
      } catch (e) {
        return { state: 'down', detail: e instanceof Error ? e.message : String(e), loadedModel: null, checkedAt };
      }
    },

    async listModels(callOpts): Promise<ModelInfo[]> {
      const installed = new Map((await tags(callOpts)).map((t) => [t.name, t]));
      return config.models.map((id) => {
        const tag = installed.get(id);
        return { id, installed: Boolean(tag), sizeBytes: tag?.size, languages: opts.languages };
      });
    },

    capabilities() {
      return { streaming: true, audioInput: false, maxContextTokens: opts.maxContextTokens, languages: opts.languages };
    },

    async unload(model: string) {
      const res = await call('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        timeoutMs: 30_000,
      });
      if (!res.ok && res.status !== 404) throw err('internal', `ollama unload ${model}: HTTP ${res.status}`);
    },

    async *stream(input, callOpts): AsyncIterable<TextStreamEvent> {
      const req = TextRequestSchema.parse(input);
      if (!config.models.includes(req.model)) {
        throw err('model_missing', `model "${req.model}" is not configured for ${providerId}`);
      }
      const options: Record<string, unknown> = { temperature: req.temperature, num_predict: req.maxTokens };
      if (opts.numCtx !== null) options.num_ctx = opts.numCtx;
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
        think: req.think || opts.think ? true : false,
        options,
      };
      if (opts.keepAlive !== null) body.keep_alive = opts.keepAlive;
      if (req.json) body.format = 'json';

      const res = await call('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: callOpts?.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        if (res.status === 404 || /not found/i.test(text)) throw err('model_missing', `ollama: model "${req.model}" not installed (${text.slice(0, 200)})`);
        throw err('unavailable', `ollama /api/chat: HTTP ${res.status} ${text.slice(0, 200)}`);
      }

      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      const handle = (line: string): TextStreamEvent[] => {
        if (!line.trim()) return [];
        let chunk: OllamaChatChunk;
        try {
          chunk = JSON.parse(line) as OllamaChatChunk;
        } catch (e) {
          throw err('internal', `ollama: unparsable stream line ${line.slice(0, 120)}`, e);
        }
        if (chunk.error) throw err(/not found/i.test(chunk.error) ? 'model_missing' : 'internal', `ollama: ${chunk.error}`);
        const out: TextStreamEvent[] = [];
        const delta = chunk.message?.content ?? '';
        if (delta) {
          acc += delta;
          out.push({ type: 'delta', text: delta });
        }
        if (chunk.done) {
          out.push({
            type: 'done',
            text: acc,
            model: chunk.model ?? req.model,
            usage: {
              inputTokens: chunk.prompt_eval_count,
              outputTokens: chunk.eval_count,
              loadMs: nsToMs(chunk.load_duration),
              totalMs: nsToMs(chunk.total_duration),
            },
          });
        }
        return out;
      };

      const reader = res.body.getReader();
      try {
        for (;;) {
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch (e) {
            if (callOpts?.signal?.aborted) throw err('cancelled', 'ollama stream cancelled', e);
            throw err('unavailable', 'ollama stream broke', e);
          }
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            for (const ev of handle(line)) {
              yield ev;
              if (ev.type === 'done') return;
            }
          }
        }
        for (const ev of handle(buf)) {
          yield ev;
          if (ev.type === 'done') return;
        }
        throw err('internal', 'ollama stream ended without done');
      } finally {
        reader.releaseLock();
      }
    },
  };
};

export const textOllama: ProviderModule<'text'> = { modality: 'text', providerId: 'ollama', create: createOllamaText };
