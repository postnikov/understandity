import { describe, expect, it } from 'vitest';
import { EngineError } from '@understandity/contracts';
import { createDispatcher } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('dispatcher: one heavy task at a time', () => {
  it('serialises tasks and never runs two at once', async () => {
    const d = createDispatcher();
    let running = 0;
    let maxRunning = 0;
    const job = (label: string) =>
      d.run({ modality: 'text', owner: 'ollama:gemma', label }, async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(10);
        running--;
        return label;
      });
    const results = await Promise.all([job('a'), job('b'), job('c')]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(d.status().active).toBeNull();
    expect(d.status().resident).toBe('ollama:gemma');
  });

  it('unloads the previous owner when another heavy engine takes over', async () => {
    const d = createDispatcher();
    const unloaded: string[] = [];
    d.setUnloader('text', async (owner) => void unloaded.push(owner));
    await d.run({ modality: 'text', owner: 'ollama:gemma', label: 'turn' }, async () => 1);
    await d.run({ modality: 'text', owner: 'ollama:gemma', label: 'turn 2' }, async () => 2);
    expect(unloaded).toEqual([]);
    await d.run({ modality: 'image', owner: 'comfyui:z-image', label: 'picture' }, async () => 3);
    expect(unloaded).toEqual(['ollama:gemma']);
  });

  it('fails fast with busy when queue=false', async () => {
    const d = createDispatcher();
    const long = d.run({ modality: 'image', owner: 'comfyui:z', label: 'long' }, () => sleep(30));
    await expect(
      d.run({ modality: 'text', owner: 'ollama:gemma', label: 'quick' }, async () => 1, { queue: false }),
    ).rejects.toMatchObject({ code: 'busy' });
    await long;
  });

  it('times out with an explicit EngineError and frees the slot', async () => {
    const d = createDispatcher();
    const err = await d
      .run({ modality: 'tts', owner: 'mlx:qwen3', label: 'slow' }, () => sleep(50), { timeoutMs: 5 })
      .catch((e) => e);
    expect(EngineError.is(err) && err.code).toBe('timeout');
    expect(await d.run({ modality: 'tts', owner: 'mlx:qwen3', label: 'next' }, async () => 'ok')).toBe('ok');
  });
});
