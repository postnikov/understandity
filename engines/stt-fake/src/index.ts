import { EngineError, type AdapterFactory, type ProviderModule, type SttAdapter } from '@understandity/contracts';

/** Rotates through answers a 12–14 y.o. might say about floating/sinking, so the tutor branch is visible. */
const CANNED = [
  'Половинка всплывёт, потому что стала легче.',
  'Объём тоже стал вдвое меньше.',
  'Масса на один кубик осталась такой же, значит она всё равно утонет.',
];

export const createFakeStt: AdapterFactory<'stt'> = (config, { providerId }): SttAdapter => {
  let turn = 0;
  return {
    modality: 'stt',
    provider: providerId,
    locality: config.locality,
    heavy: false,
    async health() {
      return { state: 'ok', detail: 'fake transcriber, audio is ignored', loadedModel: null, checkedAt: new Date().toISOString() };
    },
    async listModels() {
      return config.models.map((id) => ({ id, label: 'Fake STT', installed: true, languages: ['ru'] }));
    },
    capabilities() {
      return { languageDetection: false, maxClipSeconds: 30, inputFormats: ['audio/webm', 'audio/mp4', 'audio/wav'], languages: ['ru'] };
    },
    async transcribe(req) {
      if (req.audio.byteLength === 0) {
        throw new EngineError('no_speech', 'empty recording — answer not received', { modality: 'stt', provider: providerId });
      }
      const text = CANNED[turn % CANNED.length]!;
      turn++;
      // ~16 kB/s for opus-ish recordings; only used to look plausible.
      const durationSec = Math.min(30, Math.max(1, req.audio.byteLength / 16000));
      return { text, language: req.language === 'auto' ? 'ru' : req.language, durationSec, confidence: 0.9, model: req.model };
    },
  };
};

export const sttFake: ProviderModule<'stt'> = { modality: 'stt', providerId: 'fake', create: createFakeStt };
