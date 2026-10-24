import {
  EngineError,
  type DispatchOptions,
  type DispatcherStatus,
  type HeavyTask,
  type Modality,
  type ResourceDispatcher,
  type Unloader,
} from '@understandity/contracts';

export interface DispatcherOptions {
  /**
   * After a timed-out/cancelled task was force-unloaded, how long to still wait for its `fn` to settle
   * before the next heavy task starts. Without an unloader the dispatcher waits for `fn` without a limit:
   * there is no other way to know the memory is free.
   */
  drainGraceMs?: number;
}

interface Pending {
  task: HeavyTask;
  start: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * In-process FIFO dispatcher: exactly one heavy task occupies memory at a time.
 *
 * - Before a task whose owner differs from the resident one, the previous owner is unloaded.
 * - Timeout or abort rejects the caller at once, but the slot stays `active` until a drain barrier passes:
 *   the task's owner is force-unloaded (if an unloader is registered) and its `fn` settles or the grace runs out.
 *   Only then the next heavy task starts — two heavy models never overlap in memory.
 * - After a forced unload nothing is resident, so a retry of the same owner loads it fresh.
 * - An already-aborted signal never enters the queue; aborting while queued leaves the queue immediately.
 */
export function createDispatcher(options: DispatcherOptions = {}): ResourceDispatcher {
  const drainGraceMs = options.drainGraceMs ?? 5_000;
  let active: (HeavyTask & { startedAt: string }) | null = null;
  let resident: { owner: string; modality: Modality } | null = null;
  const queue: Pending[] = [];
  const unloaders = new Map<Modality, Unloader>();

  const pump = () => {
    if (active) return;
    queue.shift()?.start();
  };

  async function switchOwner(task: HeavyTask) {
    if (resident && resident.owner !== task.owner) {
      const unload = unloaders.get(resident.modality);
      if (unload) await unload(resident.owner);
    }
    resident = { owner: task.owner, modality: task.modality };
  }

  /** Barrier after a timeout/abort: free the memory of `task` before anyone else may start. */
  async function drain(task: HeavyTask, settled: Promise<void>) {
    const unload = unloaders.get(task.modality);
    if (!unload) {
      await settled;
      return;
    }
    try {
      await unload(task.owner);
    } catch (err) {
      console.error(`dispatcher: forced unload of ${task.owner} failed, waiting for the task to finish`, err);
      await settled;
      return;
    }
    if (resident?.owner === task.owner) resident = null;
    await Promise.race([settled, sleep(drainGraceMs)]);
  }

  const cancelled = (task: HeavyTask, why: string) =>
    new EngineError('cancelled', `task "${task.label}" ${why}`, { modality: task.modality });

  return {
    setUnloader(modality, unload) {
      unloaders.set(modality, unload);
    },

    status(): DispatcherStatus {
      return {
        active: active ? { ...active } : null,
        queued: queue.map((p) => ({ ...p.task })),
        resident: resident?.owner ?? null,
      };
    },

    run<T>(task: HeavyTask, fn: (signal: AbortSignal) => Promise<T>, opts: DispatchOptions = {}): Promise<T> {
      if (opts.signal?.aborted) return Promise.reject(cancelled(task, 'cancelled before queueing'));
      if (opts.queue === false && (active || queue.length > 0)) {
        return Promise.reject(
          new EngineError('busy', `heavy engine busy with "${active?.label ?? 'queued task'}"`, { modality: task.modality }),
        );
      }

      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let started = false;

        const onExternalAbort = () => {
          if (started) {
            controller.abort('cancelled');
            return;
          }
          const i = queue.indexOf(pending);
          if (i >= 0) queue.splice(i, 1);
          reject(cancelled(task, 'cancelled while queued'));
        };
        opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

        const start = async () => {
          started = true;
          active = { ...task, startedAt: new Date().toISOString() };
          const timer = opts.timeoutMs ? setTimeout(() => controller.abort('timeout'), opts.timeoutMs) : undefined;

          const work = switchOwner(task).then(() => {
            if (controller.signal.aborted) throw cancelled(task, 'cancelled before start');
            return fn(controller.signal);
          });
          const settled = work.then(
            () => undefined,
            () => undefined,
          );
          const abortedP = new Promise<never>((_, rej) => {
            const onAbort = () =>
              rej(
                controller.signal.reason === 'timeout'
                  ? new EngineError('timeout', `task "${task.label}" exceeded ${opts.timeoutMs} ms`, { modality: task.modality })
                  : cancelled(task, 'cancelled'),
              );
            if (controller.signal.aborted) onAbort();
            else controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          abortedP.catch(() => undefined);

          try {
            resolve(await Promise.race([work, abortedP]));
          } catch (err) {
            reject(err);
            // fn may still hold the model: keep the slot until the barrier passes.
            if (controller.signal.aborted) await drain(task, settled);
          } finally {
            if (timer) clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onExternalAbort);
            active = null;
            pump();
          }
        };

        const pending: Pending = { task, start: () => void start() };
        queue.push(pending);
        pump();
      });
    },
  };
}
