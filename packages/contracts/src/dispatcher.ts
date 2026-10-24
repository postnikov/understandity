import { z } from 'zod';
import { ModalitySchema, type Modality } from './common.js';

/**
 * "One heavy task at a time." All heavy engines (Gemma, Qwen, ComfyUI, Qwen3-TTS) share one local dispatcher.
 * When the resident owner changes, the dispatcher unloads the previous one first. The ComfyUI owner-guard
 * on Studio (requires empty Ollama) is never bypassed.
 */
export const HeavyTaskSchema = z.object({
  modality: ModalitySchema,
  /** `<provider>:<model>` — the thing that occupies memory. */
  owner: z.string().min(1),
  label: z.string().min(1),
});
export type HeavyTask = z.infer<typeof HeavyTaskSchema>;

export const DispatcherStatusSchema = z.object({
  active: HeavyTaskSchema.extend({ startedAt: z.string() }).nullable(),
  queued: z.array(HeavyTaskSchema),
  /** Owner still resident in memory after its task finished (kept warm, e.g. Gemma between turns). */
  resident: z.string().nullable(),
});
export type DispatcherStatus = z.infer<typeof DispatcherStatusSchema>;

export interface DispatchOptions {
  /** If false and something heavy is running, fail fast with `EngineError('busy')`. Default true. */
  queue?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Called by the dispatcher to free memory of the previous owner. */
export type Unloader = (owner: string) => Promise<void>;

export interface ResourceDispatcher {
  run<T>(task: HeavyTask, fn: (signal: AbortSignal) => Promise<T>, opts?: DispatchOptions): Promise<T>;
  status(): DispatcherStatus;
  /** Register how to unload owners of a modality. */
  setUnloader(modality: Modality, unload: Unloader): void;
}
