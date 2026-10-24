import {
  EngineError,
  isOfflineSafe,
  type EngineAdapter,
  type EnginesConfig,
  type Modality,
  type ModelInfo,
  type ProviderConfig,
  type ResourceDispatcher,
  type Settings,
  type TtsAdapter,
} from '@understandity/contracts';

export interface TtsRoute {
  provider: string;
  model: string;
  voice: string | null;
}

/** `options.routes` of a router provider: language (`en`, `ru`, …) → concrete TTS provider, model and voice. */
export function routesOf(config: ProviderConfig): Record<string, TtsRoute> | null {
  const routes = config.options.routes;
  if (!routes || typeof routes !== 'object') return null;
  return routes as Record<string, TtsRoute>;
}

/**
 * Voice by language: one TTS selection that sends each utterance to the engine configured for its language
 * (en → Kokoro, ru → Qwen3). Routes live in `config/engines.json`, the engines screen shows them in the
 * provider's model list. Heavy routes still go through the dispatcher; the Offline rule is checked per route.
 */
export function createTtsRouter(opts: {
  providerId: string;
  config: ProviderConfig;
  routes: Record<string, TtsRoute>;
  engines: EnginesConfig;
  adapter: (modality: Modality, provider: string) => EngineAdapter<Modality> | undefined;
  dispatcher: ResourceDispatcher;
  settings: () => Settings;
}): TtsAdapter {
  const { providerId, config, routes, engines } = opts;
  const sub = (provider: string) => opts.adapter('tts', provider) as TtsAdapter | undefined;
  const label = (r: TtsRoute) => `${engines.providers.tts[r.provider]?.label ?? r.provider}${r.voice ? ` · ${r.voice}` : ''}`;

  return {
    modality: 'tts',
    provider: providerId,
    locality: config.locality,
    heavy: false,
    async health(callOpts) {
      const parts = await Promise.all(
        Object.entries(routes).map(async ([lang, r]) => {
          const h = await sub(r.provider)?.health(callOpts).catch(() => null);
          return { lang, r, state: h?.state ?? 'down' };
        }),
      );
      const ok = parts.filter((p) => p.state === 'ok').length;
      return {
        state: ok === parts.length ? 'ok' : ok > 0 ? 'degraded' : 'down',
        detail: parts.map((p) => `${p.lang} → ${label(p.r)}: ${p.state}`).join(' · '),
        loadedModel: null,
        checkedAt: new Date().toISOString(),
      };
    },
    async listModels(): Promise<ModelInfo[]> {
      return config.models.map((id) => ({
        id,
        label: Object.entries(routes)
          .map(([lang, r]) => `${lang} → ${label(r)}`)
          .join(' · '),
        installed: true,
        languages: Object.keys(routes),
      }));
    },
    capabilities() {
      const cloud = Object.values(routes).some((r) => engines.providers.tts[r.provider]?.locality === 'cloud');
      return { streaming: false, outputFormat: 'wav', sampleRateHz: 24000, languages: Object.keys(routes), sendsTextToCloud: cloud };
    },
    async synthesize(req, callOpts) {
      const lang = req.language.split('-')[0]!.toLowerCase();
      const route = routes[lang] ?? routes['*'];
      if (!route) throw new EngineError('unsupported', `no voice configured for language "${lang}"`, { modality: 'tts', provider: providerId });
      const target = sub(route.provider);
      const targetConfig = engines.providers.tts[route.provider];
      if (!target || !targetConfig) {
        throw new EngineError('unavailable', `voice route ${lang} → "${route.provider}" is not wired`, { modality: 'tts', provider: providerId });
      }
      if (opts.settings().profile === 'offline' && !isOfflineSafe(targetConfig)) {
        throw new EngineError('offline_forbidden', `voice route ${lang} → "${route.provider}" is forbidden in the Offline profile`, {
          modality: 'tts',
          provider: route.provider,
        });
      }
      const call = (signal?: AbortSignal) =>
        target.synthesize({ ...req, model: route.model, voice: route.voice ?? undefined }, { signal: signal ?? callOpts?.signal });
      if (!target.heavy) return call();
      return opts.dispatcher.run({ modality: 'tts', owner: `${route.provider}:${route.model}`, label: `speak ${lang}` }, call, {
        timeoutMs: 120_000,
        signal: callOpts?.signal,
      });
    },
  };
}
