import { loadEnginesConfig } from '../src/config.js';

/** `config/engines.json` with every modality switched to its fake provider: tests never touch real models. */
export function fakeEnginesConfig() {
  const config = loadEnginesConfig();
  for (const m of ['text', 'stt', 'tts', 'image'] as const) {
    const fake = config.providers[m].fake!;
    config.defaults.engines[m] = { provider: 'fake', model: fake.models[0]!, voice: fake.voices[0] ?? null };
  }
  config.defaults.language = 'ru';
  return config;
}
