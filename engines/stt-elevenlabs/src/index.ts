import { type AdapterFactory, type ProviderModule } from '@understandity/contracts';
import { runtime } from '../../stt-whisper-cpp/src/runtime.js';

export const createElevenLabsStt: AdapterFactory<'stt'> = (config, { providerId }) => {
  const r = runtime(config, 'stt', providerId);
  return {
    modality: 'stt', provider: providerId, locality: 'cloud', heavy: false,
    async health() { return { state: config.enabled && !!process.env[config.secretEnv ?? ''] ? 'degraded' : 'down', detail: 'cloud STT; readiness is configuration only, no paid probe', checkedAt: new Date().toISOString() }; },
    async listModels() { return config.models.map(id => ({ id, installed: config.enabled && !!process.env[config.secretEnv ?? ''] })); },
    capabilities: () => ({ languageDetection: true, maxClipSeconds: r.num('maxClipSec', 30), inputFormats: ['audio/webm', 'audio/mp4', 'audio/wav', 'audio/ogg'], languages: [] }),
    async transcribe(req, opts) {
      r.checkModel(req.model);
      if (!config.enabled) throw r.error('unavailable', 'cloud provider is disabled');
      r.headers();
      return r.temp(async dir => {
        const clip = await r.normalize(req, dir, opts?.signal), form = new FormData();
        form.set('model_id', req.model); form.set('file', new Blob([new Uint8Array(clip.wav)], { type: 'audio/wav' }), 'recording.wav');
        form.set('diarize', 'false'); form.set('tag_audio_events', 'false');
        if (req.language !== 'auto') form.set('language_code', req.language.split('-')[0]!);
        const result = await r.request('/v1/speech-to-text', { method: 'POST', body: form }, opts?.signal);
        let data; try { data = JSON.parse(result.bytes.toString('utf8')); } catch { throw r.error('internal', 'Scribe returned invalid JSON'); }
        if (typeof data.text !== 'string') throw r.error('internal', 'Scribe returned no transcript field');
        if (!data.text.trim()) throw r.error('no_speech', 'speech was not detected');
        // language_probability measures language detection, not transcript confidence.
        return { text: data.text.trim(), language: data.language_code ?? null, durationSec: clip.durationSec, confidence: null, model: req.model };
      });
    },
  };
};
export const sttElevenLabs: ProviderModule<'stt'> = { modality: 'stt', providerId: 'elevenlabs', create: createElevenLabsStt };
