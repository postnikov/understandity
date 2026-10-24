import { TtsRequestSchema, type AdapterFactory, type ProviderModule, type TtsAdapter } from '@understandity/contracts';

const SAMPLE_RATE = 16000;

/** Soft "talking" beeps: one short tone per word, capped at 4 s. Real WAV, so the browser path is exercised. */
export function beepWav(text: string): { wav: Uint8Array; durationSec: number } {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const durationSec = Math.min(4, 0.18 * words + 0.2);
  const samples = Math.floor(durationSec * SAMPLE_RATE);
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  const wordLen = Math.floor(0.18 * SAMPLE_RATE);
  for (let i = 0; i < samples; i++) {
    const w = Math.floor(i / wordLen);
    const inWord = (i % wordLen) / wordLen;
    const freq = 220 + ((w * 37) % 5) * 30;
    const env = inWord < 0.7 ? Math.sin((Math.PI * inWord) / 0.7) : 0;
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * env * 6000), true);
  }
  return { wav: new Uint8Array(buf), durationSec };
}

export const createFakeTts: AdapterFactory<'tts'> = (config, { providerId }): TtsAdapter => ({
  modality: 'tts',
  provider: providerId,
  locality: config.locality,
  heavy: false,
  async health() {
    return { state: 'ok', detail: 'fake voice: beeps instead of speech', loadedModel: null, checkedAt: new Date().toISOString() };
  },
  async listModels() {
    return config.models.map((id) => ({ id, label: 'Fake TTS', installed: true, voices: config.voices, languages: ['ru', 'en', 'es'] }));
  },
  capabilities() {
    return { streaming: false, outputFormat: 'wav', sampleRateHz: SAMPLE_RATE, languages: ['ru', 'en', 'es'], sendsTextToCloud: false };
  },
  async synthesize(input) {
    const req = TtsRequestSchema.parse(input);
    const { wav, durationSec } = beepWav(req.text);
    return { audio: wav, mimeType: 'audio/wav', durationSec, model: req.model, voice: req.voice ?? 'beep' };
  },
});

export const ttsFake: ProviderModule<'tts'> = { modality: 'tts', providerId: 'fake', create: createFakeTts };
