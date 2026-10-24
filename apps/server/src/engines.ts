import {
  EngineError,
  MODALITIES,
  SettingsSchema,
  defaultSettings,
  isOfflineSafe,
  validateSettings,
  type AdapterByModality,
  type EngineAdapter,
  type EnginesConfig,
  type Modality,
  type ProviderModule,
  type ProviderSummary,
  type ResourceDispatcher,
  type Settings,
  type SettingsInput,
  type SettingsIssue,
} from '@understandity/contracts';
import { createTtsRouter, routesOf } from './tts-router.js';

type AnyAdapter = EngineAdapter<Modality>;

/** Holds adapters for every provider that is both configured and wired, plus the active settings. */
export class EngineHub {
  private readonly adapters = new Map<string, AnyAdapter>();
  private settings: Settings;

  constructor(
    readonly config: EnginesConfig,
    modules: ProviderModule<Modality>[],
    readonly dispatcher: ResourceDispatcher,
    /** Is the env var of an API key set (env or Settings). Defaults to the process environment. */
    private readonly keySet: (envName: string) => boolean = (name) => !!process.env[name],
  ) {
    for (const mod of modules) {
      const providerConfig = config.providers[mod.modality][mod.providerId];
      if (!providerConfig) continue;
      // Cloud adapters are built armed: whether they may run is decided here per call (Online profile + key),
      // while config/engines.json keeps them disabled so the offline launcher never sees an enabled cloud.
      const adapterConfig = providerConfig.locality === 'cloud' && providerConfig.secretEnv ? { ...providerConfig, enabled: true } : providerConfig;
      this.adapters.set(key(mod.modality, mod.providerId), mod.create(adapterConfig, { providerId: mod.providerId }) as AnyAdapter);
    }
    // Router providers (voice by language) are built from config on top of the wired engines.
    for (const [providerId, providerConfig] of Object.entries(config.providers.tts)) {
      const routes = routesOf(providerConfig);
      if (!routes || this.adapters.has(key('tts', providerId))) continue;
      this.adapters.set(
        key('tts', providerId),
        createTtsRouter({
          providerId,
          config: providerConfig,
          routes,
          engines: config,
          adapter: (m, p) => this.adapters.get(key(m, p)),
          dispatcher,
          settings: () => this.settings,
        }) as AnyAdapter,
      );
    }
    for (const modality of MODALITIES) {
      dispatcher.setUnloader(modality, async (owner) => {
        const [provider, ...rest] = owner.split(':');
        const adapter = this.adapters.get(key(modality, provider ?? ''));
        await adapter?.unload?.(rest.join(':'));
      });
    }
    this.settings = defaultSettings(config);
    const issues = validateSettings(this.settings, config);
    if (issues.length) throw new Error(`config/engines.json defaults are invalid: ${issues.map((i) => i.message).join('; ')}`);
  }

  getSettings(): Settings {
    return this.settings;
  }

  resetToDefaults(): void {
    this.settings = defaultSettings(this.config);
  }

  updateSettings(input: SettingsInput): { ok: boolean; settings: Settings; issues: SettingsIssue[] } {
    const next = SettingsSchema.parse(input);
    const issues = validateSettings(next, this.effective(next.profile));
    if (next.profile === 'online' && !this.anyKey()) {
      issues.push({ modality: null, code: 'provider_disabled', message: 'Online needs at least one API key (Engines → API keys)' });
    }
    for (const modality of MODALITIES) {
      const sel = next.engines[modality];
      if (this.config.providers[modality][sel.provider] && !this.adapters.has(key(modality, sel.provider))) {
        issues.push({ modality, code: 'unknown_provider', message: `${modality}: provider "${sel.provider}" has no adapter wired yet` });
      }
    }
    if (issues.length === 0) this.settings = next;
    return { ok: issues.length === 0, settings: this.settings, issues };
  }

  /** Active adapter for a modality. Refuses cloud providers in the Offline profile even if settings were bypassed. */
  get<M extends Modality>(modality: M): { adapter: AdapterByModality[M]; model: string; voice: string | null } {
    const sel = this.settings.engines[modality];
    const providerConfig = this.config.providers[modality][sel.provider];
    const adapter = this.adapters.get(key(modality, sel.provider));
    if (!providerConfig || !adapter) {
      throw new EngineError('unavailable', `${modality}: provider "${sel.provider}" is not available`, { modality, provider: sel.provider });
    }
    if (this.settings.profile === 'offline' && !isOfflineSafe(providerConfig)) {
      throw new EngineError('offline_forbidden', `${modality}: "${sel.provider}" is forbidden in the Offline profile`, {
        modality,
        provider: sel.provider,
      });
    }
    if (providerConfig.locality === 'cloud' && providerConfig.secretEnv && !this.keySet(providerConfig.secretEnv)) {
      throw new EngineError('unavailable', `${modality}: ${providerConfig.secretEnv} is not set (Engines → API keys)`, {
        modality,
        provider: sel.provider,
        retryable: false,
      });
    }
    return { adapter: adapter as unknown as AdapterByModality[M], model: sel.model, voice: sel.voice };
  }

  /** Run through the dispatcher when the adapter is heavy, directly otherwise. */
  async run<M extends Modality, T>(modality: M, label: string, fn: (a: AdapterByModality[M], model: string, signal?: AbortSignal) => Promise<T>) {
    const { adapter, model } = this.get(modality);
    if (!adapter.heavy) return fn(adapter, model);
    return this.dispatcher.run({ modality, owner: `${adapter.provider}:${model}`, label }, (signal) => fn(adapter, model, signal), {
      timeoutMs: 120_000,
    });
  }

  /**
   * Config as the current rules see it: a cloud provider counts as enabled only in the Online profile and only
   * with its key set. In Offline everything cloud stays disabled, exactly as in config/engines.json.
   */
  effective(profile: Settings['profile']): EnginesConfig {
    const providers = Object.fromEntries(
      MODALITIES.map((m) => [
        m,
        Object.fromEntries(
          Object.entries(this.config.providers[m]).map(([id, cfg]) => [
            id,
            cfg.locality === 'cloud' && cfg.secretEnv ? { ...cfg, enabled: cfg.enabled || (profile === 'online' && this.keySet(cfg.secretEnv)) } : cfg,
          ]),
        ),
      ]),
    ) as EnginesConfig['providers'];
    return { ...this.config, providers };
  }

  /**
   * A text engine picked by name, outside the active settings (course on request: local or online toggle).
   * Cloud needs its key; `null` when the provider is not configured, not wired or has no key.
   */
  textEngine(providerId: string): { adapter: AdapterByModality['text']; config: EnginesConfig['providers']['text'][string] } | null {
    const cfg = this.config.providers.text[providerId];
    const adapter = this.adapters.get(key('text', providerId));
    if (!cfg || !adapter) return null;
    if (cfg.locality === 'cloud' && (!cfg.secretEnv || !this.keySet(cfg.secretEnv))) return null;
    return { adapter: adapter as unknown as AdapterByModality['text'], config: cfg };
  }

  anyKey(): boolean {
    return MODALITIES.some((m) => Object.values(this.config.providers[m]).some((c) => c.locality === 'cloud' && !!c.secretEnv && this.keySet(c.secretEnv)));
  }

  async summaries(): Promise<ProviderSummary[]> {
    const out: ProviderSummary[] = [];
    for (const modality of MODALITIES) {
      for (const [providerId, cfg] of Object.entries(this.config.providers[modality])) {
        const adapter = this.adapters.get(key(modality, providerId));
        const configured = cfg.models.map((id) => ({ id, installed: false }));
        // An engine that is down (ComfyUI not running) or lists nothing still shows its configured models, marked not installed.
        const [health, listed] = adapter
          ? await Promise.all([adapter.health().catch(errHealth), adapter.listModels().catch(() => [])])
          : [null, configured];
        const models = listed.length ? listed : configured;
        out.push({
          modality,
          provider: providerId,
          label: cfg.label ?? providerId,
          locality: cfg.locality,
          enabled: this.effective(this.settings.profile).providers[modality][providerId]!.enabled,
          offlineSafe: isOfflineSafe(cfg),
          health,
          models,
          capabilities: adapter ? (adapter.capabilities() as Record<string, unknown>) : null,
        });
      }
    }
    return out;
  }
}

function key(modality: Modality, provider: string) {
  return `${modality}/${provider}`;
}

function errHealth(err: unknown) {
  return { state: 'down' as const, detail: err instanceof Error ? err.message : String(err), checkedAt: new Date().toISOString() };
}
