import { describe, expect, it } from 'vitest';
import type { EngineAdapter, Modality, Settings, TtsAdapter } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { loadEnginesConfig } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { createTtsRouter, routesOf } from '../src/tts-router.js';

function stub(provider: string, heavy: boolean, calls: string[]): TtsAdapter {
  return {
    modality: 'tts', provider, locality: 'local', heavy,
    health: async () => ({ state: 'ok', checkedAt: '' }),
    listModels: async () => [],
    capabilities: () => ({ streaming: false, outputFormat: 'wav', sampleRateHz: 24000, languages: [], sendsTextToCloud: false }),
    synthesize: async (req) => {
      calls.push(`${provider}:${req.model}:${req.voice}:${req.language}`);
      return { audio: new Uint8Array([1]), mimeType: 'audio/wav', durationSec: 1, model: req.model, voice: req.voice ?? null };
    },
  };
}

function router(profile: Settings['profile'] = 'offline') {
  const config = loadEnginesConfig();
  const routerConfig = config.providers.tts['by-language']!;
  const calls: string[] = [];
  const dispatcher = createDispatcher();
  const heavyRuns: string[] = [];
  const run = dispatcher.run.bind(dispatcher);
  dispatcher.run = (task, fn, o) => (heavyRuns.push(task.owner), run(task, fn, o));
  const adapters: Record<string, EngineAdapter<Modality>> = {
    kokoro: stub('kokoro', false, calls) as EngineAdapter<Modality>,
    'mlx-qwen3': stub('mlx-qwen3', true, calls) as EngineAdapter<Modality>,
  };
  const r = createTtsRouter({
    providerId: 'by-language', config: routerConfig, routes: routesOf(routerConfig)!, engines: config,
    adapter: (_m, p) => adapters[p], dispatcher, settings: () => ({ ...config.defaults, profile } as unknown as Settings),
  });
  return { r, calls, heavyRuns, config };
}

describe('voice by language', () => {
  it('en goes to Kokoro directly (light), ru to Qwen3 through the dispatcher (heavy)', async () => {
    const { r, calls, heavyRuns } = router();
    await r.synthesize({ model: 'auto', text: 'Hello', language: 'en' });
    await r.synthesize({ model: 'auto', text: 'Привет', language: 'ru-RU' });
    expect(calls).toEqual([
      'kokoro:mlx-community/Kokoro-82M-bf16:af_heart:en',
      'mlx-qwen3:mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit:Aiden:ru-RU',
    ]);
    expect(heavyRuns).toEqual(['mlx-qwen3:mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit']);
  });

  it('a language without a route is an explicit error, not a silent fallback', async () => {
    await expect(router().r.synthesize({ model: 'auto', text: 'Hola', language: 'es' })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('a cloud route is refused in the Offline profile', async () => {
    const { config } = router();
    const routerConfig = { ...config.providers.tts['by-language']!, options: { routes: { en: { provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: null } } } };
    const r = createTtsRouter({
      providerId: 'by-language', config: routerConfig, routes: routesOf(routerConfig)!, engines: config,
      adapter: () => stub('elevenlabs', false, []) as EngineAdapter<Modality>, dispatcher: createDispatcher(),
      settings: () => ({ profile: 'offline' } as Settings),
    });
    await expect(r.synthesize({ model: 'auto', text: 'Hi', language: 'en' })).rejects.toMatchObject({ code: 'offline_forbidden' });
  });

  it('is the demo default and shows both routes on the engines screen', async () => {
    const hub = new EngineHub(loadEnginesConfig(), PROVIDERS, createDispatcher());
    expect(hub.getSettings().engines.tts.provider).toBe('by-language');
    const summary = (await hub.summaries()).find((p) => p.provider === 'by-language')!;
    expect(summary.models[0]!.label).toMatch(/en → Kokoro.*af_heart.*ru → Qwen3.*Aiden/);
    expect(summary.offlineSafe).toBe(true);
  });
});
