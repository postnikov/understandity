import { afterEach, expect, it } from 'vitest';
import { writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createWhisperStt } from '../src/index.js';
import { clip, config, executable } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });
it('runs whisper with auto language, mono PCM, no translation, and parses timestamps', async () => {
  const f = await executable(`import sys,json,wave\nfrom pathlib import Path\na=sys.argv\nif '--version' in a: print('fixture');sys.exit(0)\nassert '-tr' not in a\nassert a[a.index('-l')+1]=='auto'\nw=wave.open(a[a.index('-f')+1]);assert (w.getnchannels(),w.getframerate(),w.getsampwidth())==(1,16000,2)\nPath(a[a.index('-of')+1]+'.json').write_text(json.dumps({'result':{'language':'ru'},'transcription':[{'text':' Лёд плавает.','offsets':{'from':0,'to':100}}]}))\n`); cleanup.push(f.close);
  const modelFile = join(f.dir, 'weights.bin'); await writeFile(modelFile, 'fixture');
  const a = createWhisperStt(config({ binary: f.path, modelFile }), { providerId: 'whisper-cpp' });
  expect((await a.health()).state).toBe('ok');
  expect(a.heavy).toBe(true);
  const result = await a.transcribe(clip());
  expect(result).toMatchObject({ text: 'Лёд плавает.', language: 'ru', durationSec: 0.1, segments: [{ startSec: 0, endSec: 0.1, text: 'Лёд плавает.' }] });
  await a.unload!('model');
  expect((await readdir(f.dir)).sort()).toEqual(['fake-cli', 'weights.bin']);
});
it('reports missing weights and does not download', async () => {
  const a = createWhisperStt(config({ modelFile: '/nonexistent/understandity-fixture' }), { providerId: 'whisper-cpp' });
  expect((await a.listModels())[0]?.installed).toBe(false);
  await expect(a.transcribe(clip())).rejects.toMatchObject({ code: 'model_missing' });
});
it('kills and reaps a stuck CLI on abort before unload finishes', async () => {
  const f = await executable('import time\ntime.sleep(60)\n'); cleanup.push(f.close);
  const a = createWhisperStt(config({ binary: f.path, modelFile: f.path }), { providerId: 'whisper-cpp' });
  const ctl = new AbortController();
  const promise = a.transcribe(clip(), { signal: ctl.signal });
  const rejected = expect(promise).rejects.toMatchObject({ code: 'cancelled' });
  setTimeout(() => ctl.abort(), 150);
  await rejected; await a.unload!('model');
});
