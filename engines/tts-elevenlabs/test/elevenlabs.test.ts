import { afterEach, expect, it, vi } from 'vitest';
import { createElevenLabsTts } from '../src/index.js';
import { config, mockHttp, reply, speech } from '../../stt-whisper-cpp/test/helpers.js';
import { wavInfo } from '../../stt-whisper-cpp/src/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(cleanup.splice(0).map(f => f())); });
it('reads the key only at runtime and wraps returned PCM as playable WAV', async () => {
  let valid = false;
  const s = await mockHttp((req, res, body) => {
    valid = req.url === '/v1/text-to-speech/voice?output_format=pcm_24000' && req.headers['xi-api-key'] === 'synthetic-fixture' && JSON.parse(body.toString()).model_id === 'model';
    res.writeHead(200, { 'Content-Type': 'audio/pcm' }); res.end(Buffer.alloc(4800));
  }); cleanup.push(s.close);
  const a = createElevenLabsTts(config({ authHeader: 'xi-api-key', authScheme: '' }, { endpoint: s.endpoint, locality: 'cloud', secretEnv: 'UNDERSTANDITY_TEST_KEY' }), { providerId: 'elevenlabs' });
  vi.stubEnv('UNDERSTANDITY_TEST_KEY', 'synthetic-fixture');
  const result = await a.synthesize(speech());
  expect(valid).toBe(true); expect(result.durationSec).toBe(0.1);
  expect(wavInfo(result.audio)).toMatchObject({ sampleRateHz: 24000, channels: 1 });
  expect(a.capabilities().sendsTextToCloud).toBe(true);
});
it('does not retry authentication failures or expose upstream error text', async () => {
  let calls = 0;
  const s = await mockHttp((_q, r) => { calls++; reply(r, { detail: 'echoed-fixture-secret-and-transcript' }, 401); }); cleanup.push(s.close);
  const a = createElevenLabsTts(config({}, { endpoint: s.endpoint, locality: 'cloud' }), { providerId: 'elevenlabs' });
  await expect(a.synthesize(speech())).rejects.toMatchObject({ code: 'unavailable', message: 'engine HTTP 401' });
  expect(calls).toBe(1);
});
it('disabled cloud providers make no health/model or synthesis network calls', async () => {
  let calls = 0;
  const s = await mockHttp((_q, r) => { calls++; reply(r, {}); }); cleanup.push(s.close);
  const a = createElevenLabsTts(config({}, { enabled: false, endpoint: s.endpoint, locality: 'cloud' }), { providerId: 'elevenlabs' });
  await a.health(); await a.listModels();
  await expect(a.synthesize(speech())).rejects.toMatchObject({ code: 'unavailable' });
  expect(calls).toBe(0);
});
