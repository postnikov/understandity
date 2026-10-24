import { z } from 'zod';
import { LanguageSchema, LocalitySchema, MODALITIES, ModalitySchema, type Modality } from './common.js';

/* ------------------------------------------------------------------ */
/* config/engines.json — volatile values live here, not in code        */
/* ------------------------------------------------------------------ */

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  locality: LocalitySchema,
  label: z.string().optional(),
  /** HTTP endpoint for daemon/sidecar providers. Offline profile requires loopback. */
  endpoint: z.string().url().nullable().default(null),
  /** Models this provider is configured for; `listModels()` reports which are really installed. */
  models: z.array(z.string().min(1)).min(1),
  /** TTS voices or similar. */
  voices: z.array(z.string()).default([]),
  /** Name of the env var with the API key, injected at runtime via `with-secret`. Never the value. */
  secretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable().default(null),
  /** Provider-specific knobs: binary paths, timeouts, sample rates, revisions. */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const EngineSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  voice: z.string().nullable().default(null),
});
export type EngineSelection = z.infer<typeof EngineSelectionSchema>;

export const ProfileSchema = z.enum(['offline', 'online']);
export type Profile = z.infer<typeof ProfileSchema>;

const ProvidersByModality = z.object({
  text: z.record(z.string(), ProviderConfigSchema),
  stt: z.record(z.string(), ProviderConfigSchema),
  tts: z.record(z.string(), ProviderConfigSchema),
  image: z.record(z.string(), ProviderConfigSchema),
});

export const EnginesConfigSchema = z.object({
  version: z.literal(1),
  providers: ProvidersByModality,
  defaults: z.object({
    profile: ProfileSchema,
    language: LanguageSchema,
    world: z.string().min(1),
    engines: z.object({
      text: EngineSelectionSchema,
      stt: EngineSelectionSchema,
      tts: EngineSelectionSchema,
      image: EngineSelectionSchema,
    }),
  }),
});
export type EnginesConfig = z.infer<typeof EnginesConfigSchema>;

/* ------------------------------------------------------------------ */
/* Runtime settings chosen by the user                                 */
/* ------------------------------------------------------------------ */

export const SettingsSchema = z.object({
  /** `offline`: cloud providers, auto-downloads and hidden network fallbacks are forbidden. */
  profile: ProfileSchema,
  language: LanguageSchema,
  world: z.string().min(1),
  engines: z.object({
    text: EngineSelectionSchema,
    stt: EngineSelectionSchema,
    tts: EngineSelectionSchema,
    image: EngineSelectionSchema,
  }),
});
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;

export const SettingsIssueSchema = z.object({
  modality: ModalitySchema.nullable(),
  code: z.enum(['unknown_provider', 'provider_disabled', 'unknown_model', 'unknown_voice', 'offline_forbidden']),
  message: z.string(),
});
export type SettingsIssue = z.infer<typeof SettingsIssueSchema>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A provider may run in the Offline profile only if it is local and talks to loopback (or no endpoint at all). */
export function isOfflineSafe(provider: ProviderConfig): boolean {
  if (provider.locality !== 'local') return false;
  return provider.endpoint === null || isLoopbackUrl(provider.endpoint);
}

/** Validate a selection against the config. Empty list = settings may be applied. */
export function validateSettings(settings: Settings, config: EnginesConfig): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  for (const modality of MODALITIES) {
    const sel = settings.engines[modality];
    const provider = config.providers[modality][sel.provider];
    if (!provider) {
      issues.push({ modality, code: 'unknown_provider', message: `${modality}: provider "${sel.provider}" is not in config/engines.json` });
      continue;
    }
    if (!provider.enabled) {
      issues.push({ modality, code: 'provider_disabled', message: `${modality}: provider "${sel.provider}" is disabled in config` });
    }
    if (!provider.models.includes(sel.model)) {
      issues.push({ modality, code: 'unknown_model', message: `${modality}: model "${sel.model}" is not configured for "${sel.provider}"` });
    }
    if (sel.voice !== null && provider.voices.length > 0 && !provider.voices.includes(sel.voice)) {
      issues.push({ modality, code: 'unknown_voice', message: `${modality}: voice "${sel.voice}" is not configured for "${sel.provider}"` });
    }
    if (settings.profile === 'offline' && !isOfflineSafe(provider)) {
      issues.push({
        modality,
        code: 'offline_forbidden',
        message: `${modality}: "${sel.provider}" sends data outside this machine and is forbidden in the Offline profile`,
      });
    }
  }
  return issues;
}

export function defaultSettings(config: EnginesConfig): Settings {
  return SettingsSchema.parse({
    profile: config.defaults.profile,
    language: config.defaults.language,
    world: config.defaults.world,
    engines: config.defaults.engines,
  });
}

export function providerOf(config: EnginesConfig, modality: Modality, provider: string): ProviderConfig | null {
  return config.providers[modality][provider] ?? null;
}
