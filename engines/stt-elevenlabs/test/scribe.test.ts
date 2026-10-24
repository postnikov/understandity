import { afterEach, expect, it, vi } from 'vitest';
import { createElevenLabsStt } from '../src/index.js';
import { clip, config, mockHttp, reply } from '../../stt-whisper-cpp/test/helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map(f => f())); });
it('uploads WAV as multipart to Scribe, omits auto language and never treats language probability as ASR confidence', async () => {
  vi.stubEnv('UNDERSTANDITY_TEST_KEY', 'synthetic-fixture');
  let authenticated = false, correctForm = false;
  const s = await mockHttp((req, res, body) => {
    authenticated = req.headers['xi-api-key'] === 'synthetic-fixture';
    const text = body.toString();
    correctForm = req.url === '/v1/speech-to-text' && text.includes('name="model_id"') && text.includes('scribe_v2') && text.includes('filename="recording.wav"') && !text.includes('language_code');
    reply(res, { text: 'Ice floats.', language_code: 'eng', language_probability: 0.99 });
  }); cleanup.push(s.close);
  const a = createElevenLabsStt(config({ authHeader: 'xi-api-key', authScheme: '' }, { endpoint: s.endpoint, locality: 'cloud', models: ['scribe_v2'], secretEnv: 'UNDERSTANDITY_TEST_KEY' }), { providerId: 'elevenlabs' });
  expect(await a.transcribe({ ...clip(), model: 'scribe_v2' })).toMatchObject({ text: 'Ice floats.', language: 'eng', confidence: null });
  expect(authenticated && correctForm).toBe(true);
});
it('disabled and missing-key providers cannot transmit recordings', async () => {
  let calls = 0; const s = await mockHttp((_q, r) => { calls++; reply(r, {}); }); cleanup.push(s.close);
  for (const enabled of [false, true]) {
    const a = createElevenLabsStt(config({}, { enabled, endpoint: s.endpoint, locality: 'cloud', secretEnv: 'UNDERSTANDITY_TEST_MISSING_KEY' }), { providerId: 'elevenlabs' });
    await expect(a.transcribe(clip())).rejects.toMatchObject({ code: 'unavailable' });
    expect((await a.health()).state).toBe('down');
  }
  expect(calls).toBe(0);
});
