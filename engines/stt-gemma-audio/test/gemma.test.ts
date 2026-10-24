import { afterEach, describe, expect, it } from 'vitest';
import { createGemmaStt } from '../src/index.js';
import { clip, config, mockHttp, reply, tone } from '../../stt-whisper-cpp/test/helpers.js';
import { wavInfo } from '../../stt-whisper-cpp/src/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });
describe('Gemma audio', () => {
  it('sends real normalized audio with deterministic ASR instructions and unloads the exact model', async () => {
    const requests: any[] = [];
    const server = await mockHttp((req, res, body) => {
      requests.push({ path: req.url, body: body.length ? JSON.parse(body.toString()) : null });
      if (req.url === '/api/tags') reply(res, { models: [{ name: 'model' }] });
      else if (req.url === '/api/generate') reply(res, { done: true });
      else reply(res, { choices: [{ finish_reason: 'stop', message: { content: 'Плотность льда меньше.' } }] });
    }); cleanup.push(server.close);
    const a = createGemmaStt(config({}, { endpoint: server.endpoint }), { providerId: 'gemma-audio' });
    expect((await a.listModels())[0]?.installed).toBe(true);
    const result = await a.transcribe(clip());
    expect(result).toMatchObject({ text: 'Плотность льда меньше.', confidence: null, language: null, durationSec: 0.1 });
    const request = requests.find(r => r.path === '/v1/chat/completions').body;
    expect(request).toMatchObject({ temperature: 0, seed: 0, reasoning_effort: 'none', stream: false });
    expect(wavInfo(Buffer.from(request.messages[0].content[1].input_audio.data, 'base64'))).toMatchObject({ sampleRateHz: 16000, channels: 1 });
    await a.unload!('model');
    expect(requests.at(-1)).toEqual({ path: '/api/generate', body: { model: 'model', keep_alive: 0, stream: false } });
  });
  it('rejects silence and oversized clips before HTTP, never invents a transcript', async () => {
    let calls = 0;
    const s = await mockHttp((_q, r) => { calls++; reply(r, {}); }); cleanup.push(s.close);
    const a = createGemmaStt(config({}, { endpoint: s.endpoint }), { providerId: 'gemma-audio' });
    await expect(a.transcribe({ ...clip(), audio: tone(0.1, 0) })).rejects.toMatchObject({ code: 'no_speech' });
    await expect(a.transcribe({ ...clip(), audio: tone(31) })).rejects.toMatchObject({ code: 'bad_input' });
    await expect(a.transcribe({ ...clip(), audio: new Uint8Array() })).rejects.toMatchObject({ code: 'no_speech' });
    expect(calls).toBe(0);
  });
  it('reports missing transcript and truncation instead of partial success', async () => {
    let answer: any = { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] };
    const s = await mockHttp((_q, r) => reply(r, answer)); cleanup.push(s.close);
    const a = createGemmaStt(config({}, { endpoint: s.endpoint }), { providerId: 'gemma-audio' });
    await expect(a.transcribe(clip())).rejects.toMatchObject({ code: 'bad_input' });
    answer = {}; await expect(a.transcribe(clip())).rejects.toMatchObject({ code: 'internal' });
    answer = { choices: [{ message: { content: '' } }] }; await expect(a.transcribe(clip())).rejects.toMatchObject({ code: 'no_speech' });
  });
});
