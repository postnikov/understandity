import type { EngineHub } from './engines.js';

/**
 * Optional warm-up at server start (`UNDERSTANDITY_WARMUP=1`): one short synthesis through the active TTS so the
 * first spoken reply of the demo is not a cold start (MLX: ~18.7 s cold, ~2 s warm on Studio). Off by default —
 * on a shared machine it would load a heavy model nobody asked for.
 */
export async function warmup(hub: EngineHub, log: (line: string) => void = console.log): Promise<void> {
  const { language } = hub.getSettings();
  const t0 = Date.now();
  try {
    const { voice } = hub.get('tts');
    await hub.run('tts', 'warm-up', (tts, model, signal) =>
      tts.synthesize({ model, text: language.startsWith('ru') ? 'Привет.' : 'Hello.', language, voice: voice ?? undefined }, { signal }),
    );
    log(`warm-up: tts ready in ${Date.now() - t0} ms`);
  } catch (err) {
    log(`warm-up: tts failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
