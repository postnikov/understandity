import { describe, expect, it } from 'vitest';
import { createDispatcher } from '@understandity/dispatcher';
import { loadEnginesConfig } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { warmup } from '../src/warmup.js';

describe('warm-up', () => {
  it('warms every voice route in config order, English (Kokoro) first', async () => {
    const config = loadEnginesConfig();
    // Point both routes at the fake voice so the test never touches a real sidecar.
    config.providers.tts['by-language']!.options = {
      routes: { en: { provider: 'fake', model: 'fake-tts', voice: 'beep' }, ru: { provider: 'fake', model: 'fake-tts', voice: 'beep' } },
    };
    // Text on the fake engine: a warm-up test must never load a real model.
    config.defaults.engines.text = { provider: 'fake', model: 'fake-tutor', voice: null };
    const hub = new EngineHub(config, PROVIDERS, createDispatcher());
    const lines: string[] = [];
    await warmup(hub, (l) => lines.push(l));
    expect(lines.map((l) => l.split(' ready')[0])).toEqual(['warm-up: tts en (fake)', 'warm-up: tts ru (fake)']);
  });
});
