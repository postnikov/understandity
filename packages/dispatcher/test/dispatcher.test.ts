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

/** A heavy fn that ignores its abort signal and keeps "holding the model" for `holdMs`. */
function stubbornTask(log: string[], name: string, holdMs: number) {
  return async () => {
    log.push(`${name}:start`);
    await sleep(holdMs);
    log.push(`${name}:end`);
    return name;
  };
}

describe('dispatcher: drain barrier after timeout / abort', () => {
  it('without an unloader the next heavy task waits until the timed-out fn really finishes', async () => {
    const d = createDispatcher();
    const log: string[] = [];
    const a = d.run({ modality: 'image', owner: 'comfyui:z', label: 'A' }, stubbornTask(log, 'A', 40), { timeoutMs: 5 });
    const b = d.run({ modality: 'text', owner: 'ollama:gemma', label: 'B' }, stubbornTask(log, 'B', 1));
    await expect(a).rejects.toMatchObject({ code: 'timeout' });
    // caller of A is released immediately, but the slot is still held
    expect(d.status().active?.label).toBe('A');
    await b;
    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('with an unloader the owner is force-unloaded before the next task, even if fn never settles', async () => {
    const d = createDispatcher({ drainGraceMs: 10 });
    const log: string[] = [];
    d.setUnloader('image', async (owner) => {
      await sleep(5);
      log.push(`unload:${owner}`);
    });
    const a = d.run({ modality: 'image', owner: 'comfyui:z', label: 'A' }, () => new Promise(() => log.push('A:start')), {
      timeoutMs: 5,
    });
    const b = d.run({ modality: 'text', owner: 'ollama:gemma', label: 'B' }, stubbornTask(log, 'B', 1));
    await expect(a).rejects.toMatchObject({ code: 'timeout' });
    await b;
    expect(log).toEqual(['A:start', 'unload:comfyui:z', 'B:start', 'B:end']);
    expect(d.status().resident).toBe('ollama:gemma');
  });

  it('retry of the same owner after timeout waits for the drain and loads fresh', async () => {
    const d = createDispatcher({ drainGraceMs: 1_000 });
    const log: string[] = [];
    d.setUnloader('text', async (owner) => void log.push(`unload:${owner}`));
    let running = 0;
    let maxRunning = 0;
    const tracked = (name: string, holdMs: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        return await stubbornTask(log, name, holdMs)();
      } finally {
        running--;
      }
    };
    const owner = 'ollama:gemma';
    await expect(d.run({ modality: 'text', owner, label: 'first' }, tracked('first', 30), { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(d.status().resident).toBeNull(); // forced unload cleared it: the retry must not count on a warm model
    const retry = await d.run({ modality: 'text', owner, label: 'retry' }, tracked('retry', 1));
    expect(retry).toBe('retry');
    expect(maxRunning).toBe(1);
    expect(log).toEqual(['first:start', 'unload:ollama:gemma', 'first:end', 'retry:start', 'retry:end']);
    expect(d.status().resident).toBe(owner);
  });

  it('external abort of a running task goes through the same barrier', async () => {
    const d = createDispatcher();
    const log: string[] = [];
    const ctrl = new AbortController();
    const a = d.run({ modality: 'tts', owner: 'mlx:qwen3', label: 'A' }, stubbornTask(log, 'A', 30), { signal: ctrl.signal });
    const b = d.run({ modality: 'tts', owner: 'mlx:qwen3', label: 'B' }, stubbornTask(log, 'B', 1));
    await sleep(2);
    ctrl.abort();
    await expect(a).rejects.toMatchObject({ code: 'cancelled' });
    await b;
    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });
});

describe('dispatcher: aborted signals never occupy the queue', () => {
  it('an already-aborted signal is rejected without queueing and without calling fn', async () => {
    const d = createDispatcher();
    let called = false;
    const err = await d
      .run(
        { modality: 'text', owner: 'ollama:gemma', label: 'dead' },
        async () => {
          called = true;
        },
        { signal: AbortSignal.abort() },
      )
      .catch((e) => e);
    expect(EngineError.is(err) && err.code).toBe('cancelled');
    expect(called).toBe(false);
    expect(d.status()).toEqual({ active: null, queued: [], resident: null });
    expect(await d.run({ modality: 'text', owner: 'ollama:gemma', label: 'next' }, async () => 'ok', { queue: false })).toBe('ok');
  });

  it('aborting while queued leaves the queue at once, before the running task ends', async () => {
    const d = createDispatcher();
    const log: string[] = [];
    const head = d.run({ modality: 'image', owner: 'comfyui:z', label: 'head' }, stubbornTask(log, 'head', 30));
    const ctrl = new AbortController();
    let called = false;
    const queued = d.run(
      { modality: 'text', owner: 'ollama:gemma', label: 'queued' },
      async () => {
        called = true;
      },
      { signal: ctrl.signal },
    );
    expect(d.status().queued.map((t) => t.label)).toEqual(['queued']);
    ctrl.abort();
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(d.status().queued).toEqual([]);
    expect(log).toEqual(['head:start']); // head still running
    await head;
    expect(called).toBe(false);
  });
});
