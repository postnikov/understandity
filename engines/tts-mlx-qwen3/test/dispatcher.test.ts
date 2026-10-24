import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EnginesConfigSchema, type ProviderModule, type Modality } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { EngineHub } from '../../../apps/server/src/engines.js';
import { sttGemma } from '../../stt-gemma-audio/src/index.js';
import { ttsMlx } from '../src/index.js';
import { clip, mockHttp, reply, speech } from '../../stt-whisper-cpp/test/helpers.js';
import { pcmWav } from '../../stt-whisper-cpp/src/runtime.js';

it('EngineHub serializes STT and TTS and awaits actual provider unload before synthesis', async () => {
  const events: string[] = [];
  const s = await mockHttp((req, res) => {
    if (req.url === '/v1/chat/completions') { events.push('asr'); reply(res, { choices: [{ message: { content: 'Density.' } }] }); }
    else if (req.url === '/api/generate') { events.push('ollama-unload'); reply(res, { done: true }); }
    else if (req.url === '/health') reply(res, { status: 'ok', model: 'model', loaded: false, voices: ['voice'], languages: ['en'], version: '0.1' });
    else if (req.url === '/synthesize') { events.push('tts'); res.writeHead(200).end(pcmWav(Buffer.alloc(4800), 24000)); }
    else if (req.url === '/unload') { events.push('mlx-unload'); res.writeHead(204).end(); }
    else reply(res, {});
  });
  try {
    const c = EnginesConfigSchema.parse(JSON.parse(await readFile(new URL('../../../config/engines.json', import.meta.url), 'utf8')));
    for (const [modality, provider] of [['stt', 'gemma-audio'], ['tts', 'mlx-qwen3']] as const) {
      const cfg = c.providers[modality][provider]!;
      cfg.endpoint = s.endpoint; cfg.models = ['model']; cfg.voices = ['voice'];
      c.defaults.engines[modality] = { provider, model: 'model', voice: 'voice' };
    }
    const d = createDispatcher();
    const hub = new EngineHub(c, [sttGemma, ttsMlx] as ProviderModule<Modality>[], d);
    const first = hub.run('stt', 'recording', (a, _model, signal) => a.transcribe(clip(), { signal }));
    const next = hub.run('tts', 'feedback', (a, _model, signal) => a.synthesize(speech(), { signal }));
    await Promise.all([first, next]);
    expect(events).toEqual(['asr', 'ollama-unload', 'tts']);
    await hub.run('stt', 'next recording', (a, _model, signal) => a.transcribe(clip(), { signal }));
    expect(events).toEqual(['asr', 'ollama-unload', 'tts', 'mlx-unload', 'asr']);
  } finally { await s.close(); }
});
