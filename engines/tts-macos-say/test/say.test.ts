import { afterEach, expect, it } from 'vitest';
import { createSayTts } from '../src/index.js';
import { config, executable, speech } from '../../stt-whisper-cpp/test/helpers.js';
import { wavInfo } from '../../stt-whisper-cpp/src/runtime.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(f => f())); });
it('uses installed language voice and file input, then produces browser WAV', async () => {
  const f = await executable(`import sys,wave\nfrom pathlib import Path\na=sys.argv\nif a[-1]=='?': print('voice en_US # fixture');sys.exit(0)\nassert Path(a[a.index('-f')+1]).read_text()=='Density matters.'\nw=wave.open(a[a.index('-o')+1],'wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(22050);w.writeframes(b'\\x10\\x01'*2205);w.close()\n`); cleanup.push(f.close);
  const a = createSayTts(config({ binary: f.path, languageVoices: { en: 'voice' } }), { providerId: 'macos-say' });
  expect((await a.listModels())[0]?.voices).toEqual(['voice']);
  const result = await a.synthesize({ ...speech(), voice: undefined });
  expect(result).toMatchObject({ voice: 'voice', mimeType: 'audio/wav', durationSec: 0.1 });
  expect(wavInfo(result.audio)).toMatchObject({ sampleRateHz: 24000, channels: 1 });
});
it('does not silently substitute a voice for an unsupported language', async () => {
  const a = createSayTts(config({ languageVoices: { en: 'voice' } }), { providerId: 'macos-say' });
  await expect(a.synthesize({ ...speech(), voice: undefined, language: 'xx' })).rejects.toMatchObject({ code: 'unsupported' });
  await expect(a.synthesize({ ...speech(), text: '' })).rejects.toMatchObject({ code: 'bad_input' });
});
