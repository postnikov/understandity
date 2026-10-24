import type { EngineHub } from './engines.js';
import { routesOf } from './tts-router.js';

const PHRASE: Record<string, string> = { en: 'Hello.', ru: 'Привет.' };

/**
 * Optional warm-up at server start (`UNDERSTANDITY_WARMUP=1`): one short synthesis per voice so the first spoken
 * reply of the demo is not a cold start. With voice-by-language, every route is warmed in config order —
 * English (Kokoro) first, because the demo is in English. Off by default: on a shared machine it would load
 * models nobody asked for.
 */
export async function warmup(hub: EngineHub, log: (line: string) => void = console.log): Promise<void> {
  const settings = hub.getSettings();
  const sel = settings.engines.tts;
  const routes = routesOf(hub.config.providers.tts[sel.provider] ?? ({ options: {} } as never));
  const languages = routes ? Object.keys(routes).filter((l) => l !== '*') : [settings.language];
  for (const language of languages) {
    const t0 = Date.now();
    try {
      const { voice } = hub.get('tts');
      await hub.run('tts', `warm-up ${language}`, (tts, model, signal) =>
        tts.synthesize({ model, text: PHRASE[language.split('-')[0]!] ?? 'Hello.', language, voice: voice ?? undefined }, { signal }),
      );
      log(`warm-up: tts ${language}${routes?.[language] ? ` (${routes[language]!.provider})` : ''} ready in ${Date.now() - t0} ms`);
    } catch (err) {
      log(`warm-up: tts ${language} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
