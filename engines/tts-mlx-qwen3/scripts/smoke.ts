/** Explicit local benchmark, never calls cloud or Comfy generation. Run only in a free resource window. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EnginesConfigSchema } from '@understandity/contracts';
import { createSayTts } from '../../tts-macos-say/src/index.js';
import { createWhisperStt } from '../../stt-whisper-cpp/src/index.js';
import { createGemmaStt } from '../../stt-gemma-audio/src/index.js';
import { createMlxTts } from '../src/index.js';

if (!process.argv.includes('--run-local')) throw new Error('Pass --run-local only when the shared heavy resource is free and the MLX sidecar is running');
const path = process.env.UNDERSTANDITY_ENGINES ?? fileURLToPath(new URL('../../../config/engines.json', import.meta.url));
const config = EnginesConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
const gemmaConfig = config.providers.stt['gemma-audio']!;
const response = await fetch(new URL('/api/ps', gemmaConfig.endpoint!), { signal: AbortSignal.timeout(5000), redirect: 'error' });
if (!response.ok) throw new Error('Ollama readiness request failed');
const loaded = await response.json() as { models: unknown[] };
if (!Array.isArray(loaded.models) || loaded.models.length) throw new Error('Ollama must be empty before this benchmark; do not unload another owner');
const say = createSayTts(config.providers.tts['macos-say']!, { providerId: 'macos-say' });
const whisper = createWhisperStt(config.providers.stt['whisper-cpp']!, { providerId: 'whisper-cpp' });
const gemma = createGemmaStt(gemmaConfig, { providerId: 'gemma-audio' });
const mlx = createMlxTts(config.providers.tts['mlx-qwen3']!, { providerId: 'mlx-qwen3' });
const rows: object[] = [];
async function measure<T extends { durationSec: number; text?: string; audio?: Uint8Array }>(engine: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const row = { engine, wallMs: Math.round(performance.now() - start), durationSec: result.durationSec, text: result.text, bytes: result.audio?.length };
  rows.push(row); console.log(JSON.stringify(row)); return result;
}
const recording = await measure('say', () => say.synthesize({ model: config.providers.tts['macos-say']!.models[0]!, language: 'ru', text: 'Лёд плавает в воде. Его плотность меньше. Контрольное число сорок семь.' }));
const audio = { audio: recording.audio, mimeType: 'audio/wav', language: 'auto' as const };
const whisperModel = config.providers.stt['whisper-cpp']!.models[0]!;
await measure('whisper', () => whisper.transcribe({ ...audio, model: whisperModel }));
await whisper.unload!(whisperModel);
const gemmaModel = gemmaConfig.models[0]!;
try {
  await measure('gemma-cold', () => gemma.transcribe({ ...audio, model: gemmaModel }));
  await measure('gemma-warm', () => gemma.transcribe({ ...audio, model: gemmaModel }));
} finally { await gemma.unload!(gemmaModel); }
const mlxModel = config.providers.tts['mlx-qwen3']!.models[0]!;
try {
  const voice = await measure('mlx-process', () => mlx.synthesize({ model: mlxModel, language: 'ru', voice: config.providers.tts['mlx-qwen3']!.voices[0], text: 'Важна плотность, а не только масса.' }));
  await mlx.unload!(mlxModel);
  await measure('whisper-mlx-roundtrip', () => whisper.transcribe({ audio: voice.audio, mimeType: 'audio/wav', language: 'ru', model: whisperModel }));
  await whisper.unload!(whisperModel);
} finally { await mlx.unload!(mlxModel); }
const output = process.argv.indexOf('--output');
if (output >= 0 && process.argv[output + 1]) await writeFile(process.argv[output + 1]!, JSON.stringify({ at: new Date().toISOString(), fixture: 'synthetic Milena, Russian', measurements: rows }, null, 2) + '\n');
console.log('SMOKE_DONE');
