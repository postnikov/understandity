import { afterEach, expect, it } from 'vitest';
import { createMlxTts } from '../src/index.js';
import { config, mockHttp, reply, speech } from '../../stt-whisper-cpp/test/helpers.js';
import { pcmWav } from '../../stt-whisper-cpp/src/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });
const health = { status: 'ok', model: 'model', loaded: false, voices: ['voice'], languages: ['en'], version: '0.1.0' };
it('checks model/language, calls sidecar and unloads via HTTP', async () => {
  const paths: string[] = []; let body: any;
  const s = await mockHttp((req, res, data) => {
    paths.push(req.url!);
    if (req.url === '/health') reply(res, health);
    else if (req.url === '/unload') res.writeHead(204).end();
    else { body = JSON.parse(data.toString()); res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(pcmWav(Buffer.alloc(4800), 24000)); }
  }); cleanup.push(s.close);
  const a = createMlxTts(config({ languages: ['en'] }, { endpoint: s.endpoint }), { providerId: 'mlx-qwen3' });
  expect((await a.health()).state).toBe('ok');
  expect((await a.listModels())[0]?.installed).toBe(true);
  expect(await a.synthesize(speech())).toMatchObject({ durationSec: 0.1, mimeType: 'audio/wav', model: 'model', voice: 'voice' });
  expect(body).toMatchObject({ text: 'Density matters.', sampleRateHz: 24000 });
  await a.unload!('model'); expect(paths.at(-1)).toBe('/unload'); expect(a.heavy).toBe(true);
});
it('rejects unsupported language before synthesis and rejects wrong sidecar model', async () => {
  let synthesisCalls = 0, model = 'model';
  const s = await mockHttp((req, r) => { if (req.url === '/synthesize') synthesisCalls++; reply(r, { ...health, model }); }); cleanup.push(s.close);
  const a = createMlxTts(config({}, { endpoint: s.endpoint }), { providerId: 'mlx-qwen3' });
  await expect(a.synthesize({ ...speech(), language: 'ca' })).rejects.toMatchObject({ code: 'unsupported' });
  model = 'another-model'; await expect(a.synthesize(speech())).rejects.toMatchObject({ code: 'model_missing' });
  expect(synthesisCalls).toBe(0);
});
it('maps sidecar busy and invalid audio to explicit errors', async () => {
  let busy = true;
  const s = await mockHttp((req, r) => {
    if (req.url === '/health') reply(r, health);
    else if (busy) reply(r, { error: 'busy' }, 409);
    else r.writeHead(200).end('not audio');
  }); cleanup.push(s.close);
  const a = createMlxTts(config({}, { endpoint: s.endpoint }), { providerId: 'mlx-qwen3' });
  await expect(a.synthesize(speech())).rejects.toMatchObject({ code: 'busy' });
  busy = false; await expect(a.synthesize(speech())).rejects.toMatchObject({ code: 'internal' });
});
