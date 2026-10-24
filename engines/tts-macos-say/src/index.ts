import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TtsRequestSchema, type AdapterFactory, type ProviderModule } from '@understandity/contracts';
import { activity, runtime, wavInfo } from '../../stt-whisper-cpp/src/runtime.js';

export const createSayTts: AdapterFactory<'tts'> = (config, { providerId }) => {
  const r = runtime(config, 'tts', providerId), work = activity();
  async function voices(signal?: AbortSignal) { return r.command(r.str('binary', '/usr/bin/say'), ['-v', '?'], signal); }
  return {
    modality: 'tts', provider: providerId, locality: 'local', heavy: false,
    async health(opts) {
      try { await voices(opts?.signal); return { state: 'ok', checkedAt: new Date().toISOString() }; }
      catch { return { state: 'down', detail: 'macOS say is unavailable', checkedAt: new Date().toISOString() }; }
    },
    async listModels(opts) {
      const output = await voices(opts?.signal);
      const installed = config.voices.filter(voice => output.split('\n').some(line => line.startsWith(voice + ' ')));
      return config.models.map(id => ({ id, installed: installed.length > 0, voices: installed }));
    },
    capabilities: () => ({ streaming: false, outputFormat: 'wav', sampleRateHz: r.num('sampleRateHz', 24000), languages: Object.keys(config.options.languageVoices ?? {}), sendsTextToCloud: false }),
    async synthesize(input, opts) {
      const parsed = TtsRequestSchema.safeParse(input);
      if (!parsed.success) throw r.error('bad_input', 'invalid speech request');
      const req = parsed.data; r.checkModel(req.model);
      const languageVoices = config.options.languageVoices as Record<string, string> | undefined;
      const voice = req.voice ?? languageVoices?.[req.language.split('-')[0]!];
      if (!voice || !config.voices.includes(voice)) throw r.error('unsupported', 'no configured voice for this language');
      return work.run(signal => r.temp(async dir => {
        const listing = await voices(signal);
        if (!listing.split('\n').some(line => line.startsWith(voice + ' '))) throw r.error('model_missing', 'system voice is not installed');
        const text = join(dir, 'text.txt'), aiff = join(dir, 'speech.aiff'), wav = join(dir, 'speech.wav');
        await writeFile(text, req.text, { mode: 0o600 });
        await r.command(r.str('binary', '/usr/bin/say'), ['-v', voice, '-f', text, '-o', aiff], signal);
        await r.command(r.str('ffmpeg', 'ffmpeg'), ['-nostdin', '-v', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', String(r.num('sampleRateHz', 24000)), '-c:a', 'pcm_s16le', wav], signal);
        const audio = await readFile(wav), meta = wavInfo(audio);
        if (!meta.samples.length) throw r.error('internal', 'system voice returned empty audio');
        return { audio, mimeType: 'audio/wav', durationSec: meta.durationSec, model: req.model, voice };
      }), opts?.signal);
    },
    unload: () => work.drain(),
  };
};
export const ttsSay: ProviderModule<'tts'> = { modality: 'tts', providerId: 'macos-say', create: createSayTts };
