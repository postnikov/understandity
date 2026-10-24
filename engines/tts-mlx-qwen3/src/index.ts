import { SidecarHealthSchema, TtsRequestSchema, type AdapterFactory, type ProviderModule } from '@understandity/contracts';
import { activity, runtime, wavInfo } from '../../stt-whisper-cpp/src/runtime.js';

export const createMlxTts: AdapterFactory<'tts'> = (config, { providerId }) => {
  const r = runtime(config, 'tts', providerId), work = activity();
  async function status(signal?: AbortSignal) {
    const parsed = SidecarHealthSchema.safeParse(await r.json('/health', undefined, signal));
    if (!parsed.success) throw r.error('internal', 'invalid sidecar health response');
    return parsed.data;
  }
  return {
    modality: 'tts', provider: providerId, locality: 'local', heavy: true,
    async health(opts) {
      try { const s = await status(opts?.signal); return { state: s.status === 'ok' ? 'ok' : s.status === 'loading' ? 'degraded' : 'down', loadedModel: s.loaded ? s.model : null, checkedAt: new Date().toISOString() }; }
      catch { return { state: 'down', detail: 'MLX sidecar unavailable', checkedAt: new Date().toISOString() }; }
    },
    async listModels(opts) { const s = await status(opts?.signal); return config.models.map(id => ({ id, installed: s.model === id && s.status !== 'down', voices: s.voices, languages: s.languages })); },
    capabilities: () => ({ streaming: false, outputFormat: 'wav', sampleRateHz: r.num('sampleRateHz', 24000), languages: (config.options.languages as string[] | undefined) ?? [], sendsTextToCloud: false }),
    async synthesize(input, opts) {
      const parsed = TtsRequestSchema.safeParse(input);
      if (!parsed.success) throw r.error('bad_input', 'invalid speech request');
      const req = parsed.data; r.checkModel(req.model);
      return work.run(async signal => {
        const s = await status(signal), voice = req.voice ?? config.voices[0];
        if (s.model !== req.model || s.status === 'down') throw r.error('model_missing', 'requested sidecar model is not installed');
        if (!voice || !s.voices.includes(voice) || !s.languages.includes(req.language.split('-')[0]!)) throw r.error('unsupported', 'unsupported sidecar voice or language');
        const response = await r.request('/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: req.text, language: req.language.split('-')[0], voice, instruct: req.instruct, sampleRateHz: r.num('sampleRateHz', 24000) }) }, signal);
        const meta = wavInfo(response.bytes);
        if (!meta.samples.length || meta.sampleRateHz !== r.num('sampleRateHz', 24000) || meta.channels !== 1) throw r.error('internal', 'sidecar returned unexpected audio format');
        return { audio: response.bytes, mimeType: 'audio/wav', durationSec: meta.durationSec, model: req.model, voice };
      }, opts?.signal);
    },
    async unload() {
      // The server kills and reaps its worker before acknowledging this request.
      await r.request('/unload', { method: 'POST' });
      await work.drain();
    },
  };
};
export const ttsMlx: ProviderModule<'tts'> = { modality: 'tts', providerId: 'mlx-qwen3', create: createMlxTts };
