import { EngineError, type AdapterFactory, type ProviderModule, type TextAdapter } from '@understandity/contracts';

/**
 * PLACEHOLDER. Cloud fallback for the text engine (Max: hybrid — local Gemma default, Gemini API reserve).
 * Key: env `GEMINI_API_KEY` (name from config `secretEnv`), injected only at runtime via `with-secret`.
 * Forbidden in the Offline profile (server + settings validation enforce it).
 */
export const createGeminiApiText: AdapterFactory<'text'> = (config, { providerId }): TextAdapter => {
  const notImplemented = () =>
    new EngineError('not_implemented', 'gemini-api text provider is a placeholder', { modality: 'text', provider: providerId });
  return {
    modality: 'text',
    provider: providerId,
    locality: config.locality,
    heavy: false,
    async health() {
      return { state: 'down', detail: 'not implemented yet', loadedModel: null, checkedAt: new Date().toISOString() };
    },
    async listModels() {
      return config.models.map((id) => ({ id, installed: false }));
    },
    capabilities() {
      return { streaming: true, audioInput: true, maxContextTokens: 32768, languages: ['ru', 'en', 'es', 'ca'] };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw notImplemented();
    },
  };
};

export const textGeminiApi: ProviderModule<'text'> = { modality: 'text', providerId: 'gemini-api', create: createGeminiApiText };
