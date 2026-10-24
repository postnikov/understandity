import { z } from 'zod';
import { HealthStatusSchema, LocalitySchema, ModalitySchema, ModelInfoSchema } from './common.js';
import { EngineErrorPayloadSchema } from './errors.js';
import { SettingsIssueSchema, SettingsSchema } from './settings.js';
import { DispatcherStatusSchema } from './dispatcher.js';

/** HTTP DTOs between `apps/web` and `apps/server`. All under `/api`. */

export const ProviderSummarySchema = z.object({
  modality: ModalitySchema,
  provider: z.string(),
  label: z.string(),
  locality: LocalitySchema,
  enabled: z.boolean(),
  offlineSafe: z.boolean(),
  /** null = provider is registered in config but no adapter is wired in `apps/server/src/providers.ts`. */
  health: HealthStatusSchema.nullable(),
  models: z.array(ModelInfoSchema),
  capabilities: z.record(z.string(), z.unknown()).nullable(),
});
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const EnginesResponseSchema = z.object({
  settings: SettingsSchema,
  providers: z.array(ProviderSummarySchema),
  dispatcher: DispatcherStatusSchema,
});
export type EnginesResponse = z.infer<typeof EnginesResponseSchema>;

export const SettingsUpdateResponseSchema = z.object({
  ok: z.boolean(),
  settings: SettingsSchema,
  issues: z.array(SettingsIssueSchema),
});

export const ApiErrorSchema = z.object({ error: EngineErrorPayloadSchema });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const TtsHttpRequestSchema = z.object({
  text: z.string().min(1).max(2000),
  language: z.string().min(2).optional(),
});
