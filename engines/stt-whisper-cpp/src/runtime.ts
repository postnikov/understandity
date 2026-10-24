import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineError, type EngineErrorCode, type Modality, type ProviderConfig, type SttRequest } from '@understandity/contracts';

/** Shared transport/audio plumbing; no keys, prompts or upstream error bodies in errors. */
export function runtime(config: ProviderConfig, modality: Modality, provider: string) {
  const error = (code: EngineErrorCode, message: string) => new EngineError(code, message, { modality, provider });
  const str = (name: string, fallback = '') => typeof config.options[name] === 'string' ? config.options[name] as string : fallback;
  const num = (name: string, fallback: number) => typeof config.options[name] === 'number' ? config.options[name] as number : fallback;
  const checkModel = (model: string) => { if (!config.models.includes(model)) throw error('model_missing', 'model is not configured'); };
  const checkAbort = (signal?: AbortSignal) => {
    if (signal?.aborted) throw error(signal.reason === 'timeout' || signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'engine operation stopped');
  };
  const headers = () => {
    const h: Record<string, string> = {};
    if (config.secretEnv) {
      const key = process.env[config.secretEnv];
      if (!key) throw error('unavailable', `runtime credential ${config.secretEnv} is missing`);
      h[str('authHeader', 'Authorization')] = str('authScheme', 'Bearer ') + key;
    }
    return h;
  };
  async function request(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    if (!config.endpoint) throw error('unavailable', 'endpoint is not configured');
    if (config.locality === 'cloud' && !config.enabled) throw error('unavailable', 'cloud provider is disabled');
    const timeout = AbortSignal.timeout(num('timeoutMs', 90_000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    checkAbort(combined);
    try {
      const response = await fetch(new URL(path, config.endpoint), { ...init, redirect: 'error', headers: { ...headers(), ...init.headers }, signal: combined });
      if (!response.ok) {
        // A provider error may echo the credential or child transcript. Do not return its body.
        await response.body?.cancel();
        const code = response.status === 409 || response.status === 429 ? 'busy' : response.status === 424 ? 'model_missing' : response.status === 422 ? 'unsupported' : response.status === 400 || response.status === 413 ? 'bad_input' : 'unavailable';
        throw new EngineError(code, `engine HTTP ${response.status}`, { modality, provider, ...(response.status === 401 || response.status === 403 ? { retryable: false } : {}) });
      }
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > num('maxResponseBytes', 24 * 1024 * 1024)) {
            await reader.cancel();
            throw error('internal', 'engine response exceeds size limit');
          }
          parts.push(part.value);
        }
      }
      return { bytes: Buffer.concat(parts), headers: response.headers };
    } catch (err) {
      checkAbort(combined);
      if (EngineError.is(err)) throw err;
      throw error('unavailable', 'engine request failed');
    }
  }
  async function json(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const result = await request(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
    try { return JSON.parse(result.bytes.toString('utf8')); }
    catch { throw error('internal', 'engine returned invalid JSON'); }
  }
  async function command(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(num('timeoutMs', 90_000))]) : AbortSignal.timeout(num('timeoutMs', 90_000));
    checkAbort(combined);
    return new Promise((resolve, reject) => {
      const child = spawn(expand(binary), args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      let output = '';
      const stop = () => child.kill('SIGKILL');
      combined.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (data: Buffer) => { if (output.length < 1_000_000) output += data.toString('utf8'); });
      child.on('error', () => { combined.removeEventListener('abort', stop); reject(error('unavailable', 'engine executable is unavailable')); });
      child.on('close', (code) => {
        combined.removeEventListener('abort', stop);
        try {
          checkAbort(combined);
          if (code !== 0) throw error('unavailable', 'engine process failed');
          resolve(output);
        } catch (err) { reject(err); }
      });
    });
  }
  async function temp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'understandity-'));
    try { return await fn(dir); }
    catch (err) { if (EngineError.is(err)) throw err; throw error('internal', 'local engine operation failed'); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  async function normalize(req: SttRequest, dir: string, signal?: AbortSignal) {
    if (!req.audio.length) throw error('no_speech', 'empty recording — answer not received');
    if (req.audio.length > num('maxAudioBytes', 12 * 1024 * 1024)) throw error('bad_input', 'recording exceeds size limit');
    if (!/^audio\/(webm|mp4|wav|x-wav|mpeg|ogg)(;.*)?$/.test(req.mimeType)) throw error('bad_input', 'unsupported audio container');
    const input = join(dir, 'recording');
    const output = join(dir, 'mono.wav');
    await writeFile(input, req.audio, { mode: 0o600 });
    try {
      await command(str('ffmpeg', 'ffmpeg'), ['-nostdin', '-v', 'error', '-y', '-i', input, '-t', String(num('maxClipSec', 30) + 1), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], signal);
    } catch (err) {
      if (EngineError.is(err) && err.code === 'unavailable' && err.message === 'engine process failed') throw error('bad_input', 'recording could not be decoded');
      throw err;
    }
    const wav = await readFile(output);
    const meta = wavInfo(wav);
    if (meta.durationSec > num('maxClipSec', 30) + 0.001) throw error('bad_input', 'recording is too long');
    if (!meta.samples.length || meta.rms <= num('silenceRms', 0.0001)) throw error('no_speech', 'silence — answer not received');
    return { wav, path: output, durationSec: meta.durationSec };
  }
  return { error, str, num, checkModel, checkAbort, headers, request, json, command, temp, normalize };
}

export const expand = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

/** PCM16 RIFF parser handles ffmpeg's LIST/JUNK chunks, not just 44-byte headers. */
export function wavInfo(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new EngineError('internal', 'invalid WAV');
  let rate = 0, channels = 0, pcm = Buffer.alloc(0);
  for (let p = 12; p + 8 <= b.length;) {
    const size = b.readUInt32LE(p + 4), type = b.toString('ascii', p, p + 4);
    if (p + 8 + size > b.length) throw new EngineError('internal', 'truncated WAV');
    if (type === 'fmt ' && size >= 16) {
      if (b.readUInt16LE(p + 8) !== 1 || b.readUInt16LE(p + 22) !== 16) throw new EngineError('internal', 'expected PCM16 WAV');
      channels = b.readUInt16LE(p + 10); rate = b.readUInt32LE(p + 12);
    }
    if (type === 'data') pcm = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + size % 2;
  }
  if (!rate || !channels || pcm.length % 2) throw new EngineError('internal', 'invalid WAV format');
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  return { durationSec: pcm.length / (rate * channels * 2), sampleRateHz: rate, channels, samples: pcm, rms: Math.sqrt(sum / Math.max(1, pcm.length / 2)) };
}

export function pcmWav(pcm: Uint8Array, rate: number): Buffer {
  if (!pcm.length || pcm.length % 2) throw new EngineError('internal', 'empty or malformed PCM audio');
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF'); b.writeUInt32LE(36 + pcm.length, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm.length, 40); b.set(pcm, 44);
  return b;
}

/** unload is a completion barrier, including after dispatcher timeout. */
export function activity() {
  let active: Promise<unknown> | undefined;
  let controller: AbortController | undefined;
  return {
    async run<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (active) throw new EngineError('busy', 'engine already running');
      controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      active = Promise.resolve().then(() => fn(combined));
      try { return await active as T; } finally { active = undefined; controller = undefined; }
    },
    async drain() { controller?.abort(); await active?.catch(() => {}); },
  };
}
