import { z } from 'zod';

/**
 * HTTP contract of `sidecars/tts-mlx` (Python, mlx-audio, Qwen3-TTS). Listens on 127.0.0.1 only.
 *   GET  /health      → SidecarHealth
 *   POST /synthesize  ← SidecarSynthesizeRequest (JSON) → audio/wav bytes, headers X-Duration-Sec, X-Model, X-Voice
 *   POST /unload      → 204, frees the model (dispatcher calls it)
 * Errors: JSON SidecarError with HTTP 4xx/5xx.
 */
export const SidecarHealthSchema = z.object({
  status: z.enum(['ok', 'loading', 'down']),
  model: z.string().nullable(),
  loaded: z.boolean(),
  voices: z.array(z.string()),
  languages: z.array(z.string()),
  version: z.string(),
});
export type SidecarHealth = z.infer<typeof SidecarHealthSchema>;

export const SidecarSynthesizeRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  language: z.string().min(2),
  voice: z.string().min(1),
  instruct: z.string().optional(),
  sampleRateHz: z.number().int().positive().default(24000),
});
export type SidecarSynthesizeRequest = z.infer<typeof SidecarSynthesizeRequestSchema>;

export const SidecarErrorSchema = z.object({
  error: z.enum(['bad_input', 'model_missing', 'busy', 'unsupported', 'internal']),
  message: z.string(),
});
export type SidecarError = z.infer<typeof SidecarErrorSchema>;
