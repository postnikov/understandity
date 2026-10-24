import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { loadCourse } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { KeyStore } from '../src/keys.js';
import { PROVIDERS } from '../src/providers.js';
import { fakeEnginesConfig } from './helpers.js';

const SECRET = 'sk-test-0123456789abcdef';
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'ud-keys-')), 'data', 'keys.local.json');

function makeApp(env: NodeJS.ProcessEnv = {}) {
  const keys = new KeyStore(tmpFile(), env);
  const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher(), (n) => keys.isSet(n));
  return { keys, hub, env, app: createApp({ hub, course: loadCourse(), allowDrafts: true, keys }) };
}

const put = (body: unknown) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('API keys in Settings', () => {
  it('stores a key 0600, exports it to the env, and never returns the value', async () => {
    const { app, keys, env } = makeApp();
    const res = await app.request('/api/keys/anthropic', put({ value: SECRET }));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(JSON.parse(raw).find((k: { id: string }) => k.id === 'anthropic')).toMatchObject({ set: true, source: 'file' });
    expect(env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(statSync(keys.file).mode & 0o777).toBe(0o600);
    expect((await (await app.request('/api/keys')).text())).not.toContain(SECRET);
    await app.request('/api/keys/anthropic', { method: 'DELETE' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(readFileSync(keys.file, 'utf8')).not.toContain(SECRET);
  });

  it('a saved key is loaded on the next start; the environment wins and cannot be overwritten', () => {
    const file = tmpFile();
    new KeyStore(file, {}).set('elevenlabs', SECRET);
    const env1: NodeJS.ProcessEnv = {};
    new KeyStore(file, env1);
    expect(env1.ELEVENLABS_API_KEY).toBe(SECRET);
    const env2: NodeJS.ProcessEnv = { ELEVENLABS_API_KEY: 'from-environment-123' };
    const ks = new KeyStore(file, env2);
    expect(env2.ELEVENLABS_API_KEY).toBe('from-environment-123');
    expect(ks.status().find((k) => k.id === 'elevenlabs')!.source).toBe('env');
    expect(() => ks.set('elevenlabs', SECRET)).toThrow(/environment/);
  });

  it('rejects junk values and unknown key ids', () => {
    const ks = new KeyStore(tmpFile(), {});
    expect(() => ks.set('anthropic', 'short')).toThrow();
    expect(() => ks.set('anthropic', 'has space inside the key')).toThrow();
    expect(() => ks.set('openai', SECRET)).toThrow(/unknown key/);
  });

  it('an unreadable key file is treated as empty', () => {
    const file = tmpFile();
    new KeyStore(file, {}).set('gemini', SECRET);
    writeFileSync(file, '{not json');
    expect(new KeyStore(file, {}).status().every((k) => !k.set)).toBe(true);
  });
});

describe('Online profile and cloud engines', () => {
  it('Online without any key is refused; Offline stays the default', async () => {
    const { app, hub } = makeApp();
    expect(hub.getSettings().profile).toBe('offline');
    const res = await app.request('/api/settings', put({ ...hub.getSettings(), profile: 'online' }));
    expect(res.status).toBe(422);
    expect((await res.json()).issues.map((i: { message: string }) => i.message).join()).toMatch(/API key/);
  });

  it('with a key: Online may select Anthropic; Offline still shows every cloud provider disabled', async () => {
    const { app, hub } = makeApp({ ANTHROPIC_API_KEY: SECRET });
    const offline = await (await app.request('/api/engines')).json();
    expect(offline.providers.filter((p: { locality: string; enabled: boolean }) => p.locality === 'cloud' && p.enabled)).toEqual([]);
    const s = hub.getSettings();
    const res = await app.request('/api/settings', put({ ...s, profile: 'online', engines: { ...s.engines, text: { provider: 'anthropic', model: 'claude-opus-5-5', voice: null } } }));
    expect(res.status).toBe(200);
    const online = await (await app.request('/api/engines')).json();
    expect(online.providers.find((p: { provider: string }) => p.provider === 'anthropic').enabled).toBe(true);
    expect(online.providers.find((p: { modality: string; provider: string }) => p.modality === 'tts' && p.provider === 'elevenlabs').enabled).toBe(false);
  });

  it('a cloud engine without its key fails explicitly, never silently falls back', async () => {
    const { app, hub, env } = makeApp({ ANTHROPIC_API_KEY: SECRET });
    const s = hub.getSettings();
    await app.request('/api/settings', put({ ...s, profile: 'online', engines: { ...s.engines, text: { provider: 'anthropic', model: 'claude-opus-5-5', voice: null } } }));
    delete env.ANTHROPIC_API_KEY;
    expect(() => hub.get('text')).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('clearing the last key while Online returns to the Offline defaults', async () => {
    const { app, hub } = makeApp();
    await app.request('/api/keys/anthropic', put({ value: SECRET }));
    const s = hub.getSettings();
    expect((await app.request('/api/settings', put({ ...s, profile: 'online' }))).status).toBe(200);
    await app.request('/api/keys/anthropic', { method: 'DELETE' });
    expect(hub.getSettings().profile).toBe('offline');
  });
});
