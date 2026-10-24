import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AdapterFactory, type ProviderModule } from '@understandity/contracts';
import { activity, expand, runtime } from './runtime.js';

export const createWhisperStt: AdapterFactory<'stt'> = (config, { providerId }) => {
  const r = runtime(config, 'stt', providerId), work = activity();
  const modelFile = () => expand(r.str('modelFile'));
  async function available() { await access(modelFile()); await r.command(r.str('binary', 'whisper-cli'), ['--version']); }
  return {
    // `options.heavy: false` (default in config): a short-lived ~1.6 GB process that may run next to the resident tutor model.
    modality: 'stt', provider: providerId, locality: 'local', heavy: config.options.heavy !== false,
    async health() {
      try { await available(); return { state: 'ok', checkedAt: new Date().toISOString(), loadedModel: null }; }
      catch { return { state: 'down', detail: 'whisper executable or weights unavailable', checkedAt: new Date().toISOString() }; }
    },
    async listModels() {
      let installed = false; try { await access(modelFile()); installed = true; } catch { /* no download */ }
      return config.models.map(id => ({ id, installed }));
    },
    capabilities: () => ({ languageDetection: true, maxClipSeconds: r.num('maxClipSec', 30), inputFormats: ['audio/webm', 'audio/mp4', 'audio/wav', 'audio/ogg'], languages: [] }),
    async transcribe(req, opts) {
      r.checkModel(req.model);
      try { await access(modelFile()); } catch { throw r.error('model_missing', 'whisper weights are missing'); }
      return work.run(signal => r.temp(async dir => {
        const clip = await r.normalize(req, dir, signal), output = join(dir, 'transcript');
        await r.command(r.str('binary', 'whisper-cli'), ['-m', modelFile(), '-f', clip.path, '-l', req.language, '-mc', '0', '-oj', '-of', output, '-np'], signal);
        let result;
        try { result = JSON.parse(await readFile(output + '.json', 'utf8')); } catch { throw r.error('internal', 'whisper returned invalid JSON'); }
        const segments = (result.transcription ?? []).map((s: any) => ({ text: String(s.text ?? '').trim(), startSec: Number(s.offsets?.from ?? 0) / 1000, endSec: Number(s.offsets?.to ?? 0) / 1000 }));
        const text = segments.map((s: { text: string }) => s.text).join(' ').trim();
        if (!text || /^\[.*\]$/.test(text)) throw r.error('no_speech', 'speech was not detected');
        return { text, language: result.result?.language ?? (req.language === 'auto' ? null : req.language), durationSec: clip.durationSec, confidence: null, model: req.model, segments };
      }), opts?.signal);
    },
    unload: () => work.drain(),
  };
};
export const sttWhisper: ProviderModule<'stt'> = { modality: 'stt', providerId: 'whisper-cpp', create: createWhisperStt };
