import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EngineError } from '@understandity/contracts';

/** API keys a user may give in Settings. Names match `secretEnv` in config/engines.json. */
export const KEY_SPECS = [
  { id: 'anthropic', env: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)' },
  { id: 'elevenlabs', env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs' },
  { id: 'gemini', env: 'GEMINI_API_KEY', label: 'Gemini' },
] as const;
export type KeyId = (typeof KEY_SPECS)[number]['id'];

export interface KeyStatus {
  id: KeyId;
  label: string;
  env: string;
  set: boolean;
  /** `env` — given by the environment (wins, cannot be changed here); `file` — saved in Settings. */
  source: 'env' | 'file' | null;
}

const VALUE = /^[\x21-\x7e]{8,400}$/;

/**
 * Local key store: `data/keys.local.json` (gitignored, mode 0600). Environment variables win over the file.
 * Saved keys are exported into this process's environment, which is where the engines read them at call time.
 * A value never leaves the server: the API only reports set / not set and where it came from.
 */
export class KeyStore {
  private readonly fromEnv = new Set<string>();
  private saved: Record<string, string> = {};

  constructor(
    readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const s of KEY_SPECS) if (env[s.env]) this.fromEnv.add(s.env);
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        for (const s of KEY_SPECS) if (typeof data[s.env] === 'string') this.saved[s.env] = data[s.env] as string;
      } catch {
        // An unreadable file is treated as empty; it is rewritten on the next save.
      }
    }
    for (const [name, value] of Object.entries(this.saved)) if (!this.fromEnv.has(name)) env[name] = value;
  }

  status(): KeyStatus[] {
    return KEY_SPECS.map((s) => ({
      id: s.id,
      label: s.label,
      env: s.env,
      set: !!this.env[s.env],
      source: this.fromEnv.has(s.env) ? 'env' : this.saved[s.env] ? 'file' : null,
    }));
  }

  isSet(envName: string | null | undefined): boolean {
    return !!envName && !!this.env[envName];
  }

  anySet(): boolean {
    return KEY_SPECS.some((s) => this.isSet(s.env));
  }

  set(id: string, value: unknown): KeyStatus[] {
    const spec = this.spec(id);
    if (typeof value !== 'string' || !VALUE.test(value.trim())) {
      throw new EngineError('bad_input', 'a key is 8–400 printable characters without spaces');
    }
    this.saved[spec.env] = value.trim();
    this.persist();
    this.env[spec.env] = value.trim();
    return this.status();
  }

  clear(id: string): KeyStatus[] {
    const spec = this.spec(id);
    delete this.saved[spec.env];
    this.persist();
    delete this.env[spec.env];
    return this.status();
  }

  private spec(id: string) {
    const spec = KEY_SPECS.find((s) => s.id === id);
    if (!spec) throw new EngineError('bad_input', `unknown key "${id}"`);
    if (this.fromEnv.has(spec.env)) {
      throw new EngineError('bad_input', `${spec.env} is set in the environment, which wins over Settings; change it there`);
    }
    return spec;
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
