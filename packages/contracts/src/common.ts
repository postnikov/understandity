import { z } from 'zod';

/** The four replaceable engines from the tech recon: text, speech-to-text, text-to-speech, images. */
export const ModalitySchema = z.enum(['text', 'stt', 'tts', 'image']);
export type Modality = z.infer<typeof ModalitySchema>;
export const MODALITIES = ModalitySchema.options;

/** Where the provider sends data. `cloud` providers are forbidden in the Offline profile. */
export const LocalitySchema = z.enum(['local', 'cloud']);
export type Locality = z.infer<typeof LocalitySchema>;

/** BCP-47-ish language tag; we keep it loose (`ru`, `en`, `es`, `ca`, `es-ES`). */
export const LanguageSchema = z.string().min(2).max(16);
export type Language = z.infer<typeof LanguageSchema>;

export const HealthStateSchema = z.enum(['ok', 'degraded', 'down']);
export type HealthState = z.infer<typeof HealthStateSchema>;

export const HealthStatusSchema = z.object({
  state: HealthStateSchema,
  /** Human-readable detail: "ollama not reachable on 127.0.0.1:11434", "weights missing", ... */
  detail: z.string().optional(),
  /** Model currently loaded in memory, if the engine knows it. */
  loadedModel: z.string().nullable().optional(),
  checkedAt: z.string(),
  latencyMs: z.number().nonnegative().optional(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  /** Actually present on this machine (weights downloaded / voice installed). */
  installed: z.boolean(),
  sizeBytes: z.number().int().nonnegative().optional(),
  languages: z.array(LanguageSchema).optional(),
  /** For TTS: voices this model offers. */
  voices: z.array(z.string()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;
