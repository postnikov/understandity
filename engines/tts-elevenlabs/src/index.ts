import { TtsRequestSchema, type AdapterFactory, type ProviderModule } from '@understandity/contracts';
import { pcmWav, runtime, wavInfo } from '../../stt-whisper-cpp/src/runtime.js';

/**
 * Optional cloud TTS, disabled by default. The application chooses which text may be sent.
 * Key: env `ELEVENLABS_API_KEY`, injected only at runtime via `with-secret`. Forbidden in the Offline profile.
 */
export const createElevenLabsTts: AdapterFactory<'tts'> = (config, { providerId }) => {
  const r = runtime(config, 'tts', providerId);
  return {
    modality: 'tts', provider: providerId, locality: 'cloud', heavy: false,
    async health() { return { state: config.enabled && !!process.env[config.secretEnv ?? ''] ? 'degraded' : 'down', detail: 'cloud TTS; readiness is configuration only, no paid probe', checkedAt: new Date().toISOString() }; },
    async listModels() { return config.models.map(id => ({ id, installed: config.enabled && !!process.env[config.secretEnv ?? ''], voices: config.voices })); },
    capabilities: () => ({ streaming: false, outputFormat: 'wav', sampleRateHz: r.num('sampleRateHz', 24000), languages: (config.options.languages as string[] | undefined) ?? [], sendsTextToCloud: true }),
    async synthesize(input, opts) {
      const parsed = TtsRequestSchema.safeParse(input);
      if (!parsed.success) throw r.error('bad_input', 'invalid speech request');
      const req = parsed.data; r.checkModel(req.model);
      const voice = req.voice ?? config.voices[0];
      if (!voice || (config.voices.length && !config.voices.includes(voice))) throw r.error('bad_input', 'select a configured ElevenLabs voice');
      const rate = r.num('sampleRateHz', 24000);
      const response = await r.request(`/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${rate}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, model_id: req.model }),
      }, opts?.signal);
      if (response.headers.get('content-type')?.includes('json')) throw r.error('internal', 'expected PCM audio, received JSON');
      const audio = pcmWav(response.bytes, rate);
      return { audio, mimeType: 'audio/wav', durationSec: wavInfo(audio).durationSec, model: req.model, voice };
    },
  };
};

export const ttsElevenLabs: ProviderModule<'tts'> = { modality: 'tts', providerId: 'elevenlabs', create: createElevenLabsTts };
