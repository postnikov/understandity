import {
  EngineError,
  type DispatchOptions,
  type DispatcherStatus,
  type HeavyTask,
  type Modality,
  type ResourceDispatcher,
  type Unloader,
} from '@understandity/contracts';

interface Pending {
  task: HeavyTask;
  start: () => void;
}

/**
 * In-process FIFO dispatcher: exactly one heavy task runs at a time.
 * Before a task whose owner differs from the resident one, the previous owner is unloaded.
 */
export function createDispatcher(): ResourceDispatcher {
  let active: (HeavyTask & { startedAt: string }) | null = null;
  let resident: { owner: string; modality: Modality } | null = null;
  const queue: Pending[] = [];
  const unloaders = new Map<Modality, Unloader>();

  const pump = () => {
    if (active) return;
    const next = queue.shift();
    next?.start();
  };

  async function switchOwner(task: HeavyTask) {
    if (resident && resident.owner !== task.owner) {
      const unload = unloaders.get(resident.modality);
      if (unload) await unload(resident.owner);
    }
    resident = { owner: task.owner, modality: task.modality };
  }

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
      if (opts.queue === false && (active || queue.length > 0)) {
        return Promise.reject(
          new EngineError('busy', `heavy engine busy with "${active?.label ?? 'queued task'}"`, { modality: task.modality }),
        );
      }
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort(opts.signal?.reason);
        opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

        const start = () => {
          if (controller.signal.aborted) {
            reject(new EngineError('cancelled', `task "${task.label}" cancelled before start`, { modality: task.modality }));
            pump();
            return;
          }
          active = { ...task, startedAt: new Date().toISOString() };
          let timer: ReturnType<typeof setTimeout> | undefined;
          if (opts.timeoutMs) timer = setTimeout(() => controller.abort('timeout'), opts.timeoutMs);

          const timeoutPromise = new Promise<never>((_, rej) => {
            controller.signal.addEventListener(
              'abort',
              () => {
                const reason = controller.signal.reason;
                rej(
                  reason === 'timeout'
                    ? new EngineError('timeout', `task "${task.label}" exceeded ${opts.timeoutMs} ms`, { modality: task.modality })
                    : new EngineError('cancelled', `task "${task.label}" cancelled`, { modality: task.modality }),
                );
              },
              { once: true },
            );
          });

          switchOwner(task)
            .then(() => Promise.race([fn(controller.signal), timeoutPromise]))
            .then(resolve, reject)
            .finally(() => {
              if (timer) clearTimeout(timer);
              opts.signal?.removeEventListener('abort', onExternalAbort);
              active = null;
              pump();
            });
        };

        queue.push({ task, start });
        pump();
      });
    },
  };
}
