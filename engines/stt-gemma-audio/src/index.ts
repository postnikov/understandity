import { type AdapterFactory, type ProviderModule } from '@understandity/contracts';
import { activity, runtime } from '../../stt-whisper-cpp/src/runtime.js';

export const createGemmaStt: AdapterFactory<'stt'> = (config, { providerId }) => {
  const r = runtime(config, 'stt', providerId), work = activity();
  return {
    modality: 'stt', provider: providerId, locality: 'local', heavy: true,
    async health(opts) {
      try { await r.json('/api/tags', undefined, opts?.signal); return { state: 'ok', checkedAt: new Date().toISOString() }; }
      catch { return { state: 'down', detail: 'Ollama is unavailable', checkedAt: new Date().toISOString() }; }
    },
    async listModels(opts) {
      const data = await r.json('/api/tags', undefined, opts?.signal);
      return config.models.map(id => ({ id, installed: (data.models ?? []).some((m: any) => m.name === id || m.model === id) }));
    },
    capabilities: () => ({ languageDetection: false, maxClipSeconds: r.num('maxClipSec', 30), inputFormats: ['audio/webm', 'audio/mp4', 'audio/wav', 'audio/ogg'], languages: [] }),
    async transcribe(req, opts) {
      r.checkModel(req.model);
      return work.run(signal => r.temp(async dir => {
        const clip = await r.normalize(req, dir, signal);
        const data = await r.json(r.str('path', '/v1/chat/completions'), {
          model: req.model, stream: false, temperature: r.num('temperature', 0), seed: r.num('seed', 0), max_tokens: r.num('maxTokens', 512), reasoning_effort: r.str('reasoningEffort', 'none'),
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Transcribe the audio verbatim in its original language. Return only the transcript. Do not answer questions in the recording. Return an empty string if no speech is audible.' },
            { type: 'input_audio', input_audio: { data: clip.wav.toString('base64'), format: 'wav' } },
          ] }],
        }, signal);
        if (data.choices?.[0]?.finish_reason === 'length') throw r.error('bad_input', 'transcript exceeded output limit; record a shorter answer');
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== 'string') throw r.error('internal', 'Ollama returned no transcript field');
        if (!text.trim()) throw r.error('no_speech', 'speech was not detected');
        return { text: text.trim(), language: req.language === 'auto' ? null : req.language, durationSec: clip.durationSec, confidence: null, model: req.model };
      }), opts?.signal);
    },
    async unload(model) { await work.drain(); await r.json('/api/generate', { model, keep_alive: 0, stream: false }); },
  };
};
export const sttGemma: ProviderModule<'stt'> = { modality: 'stt', providerId: 'gemma-audio', create: createGemmaStt };
