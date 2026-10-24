import { describe, expect, it } from 'vitest';
import type { Modality, ProviderModule } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { fakeEnginesConfig } from './helpers.js';

describe('engines screen model list', () => {
  it('an engine that lists no models (or fails) still shows the configured ones, not installed', async () => {
    const empty: ProviderModule<'image'> = {
      modality: 'image',
      providerId: 'comfyui',
      create: (_cfg, { providerId }) => ({
        modality: 'image', provider: providerId, locality: 'local', heavy: true,
        health: async () => ({ state: 'down', checkedAt: '' }),
        listModels: async () => { throw new Error('ComfyUI not running'); },
        capabilities: () => ({ async: true, maxWidth: 1024, maxHeight: 1024, outputFormat: 'png' }),
        generate: async () => { throw new Error('down'); },
        getJob: async () => { throw new Error('down'); },
      }),
    };
    const modules = [...PROVIDERS.filter((m) => !(m.modality === 'image' && m.providerId === 'comfyui')), empty as ProviderModule<Modality>];
    const hub = new EngineHub(fakeEnginesConfig(), modules, createDispatcher());
    const comfy = (await hub.summaries()).find((p) => p.modality === 'image' && p.provider === 'comfyui')!;
    expect(comfy.models).toEqual([{ id: 'z_image_turbo_bf16', installed: false }]);
  }, 20_000);
});
