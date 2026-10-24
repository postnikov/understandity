import { EngineError, type AdapterFactory, type ProviderModule, type TtsAdapter } from '@understandity/contracts';

/**
 * PLACEHOLDER. Optional cloud TTS, disabled by default, for prepared author text only — never child answers.
 * Key: env `ELEVENLABS_API_KEY`, injected only at runtime via `with-secret`. Forbidden in the Offline profile.
 */
export const createElevenLabsTts: AdapterFactory<'tts'> = (config, { providerId }): TtsAdapter => ({
  modality: 'tts',
  provider: providerId,
  locality: config.locality,
  heavy: false,
  async health() {
    return { state: 'down', detail: 'not implemented yet', loadedModel: null, checkedAt: new Date().toISOString() };
  },
  async listModels() {
    return config.models.map((id) => ({ id, installed: false, voices: config.voices }));
  },
  capabilities() {
    return { streaming: true, outputFormat: 'mp3', sampleRateHz: 44100, languages: ['ru', 'en', 'es'], sendsTextToCloud: true };
  },
  async synthesize() {
    throw new EngineError('not_implemented', 'elevenlabs TTS provider is a placeholder', { modality: 'tts', provider: providerId });
  },
});

export const ttsElevenLabs: ProviderModule<'tts'> = { modality: 'tts', providerId: 'elevenlabs', create: createElevenLabsTts };
