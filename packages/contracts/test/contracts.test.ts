import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CourseSchema,
  CYCLE_STEPS,
  EngineError,
  EngineErrorPayloadSchema,
  EnginesConfigSchema,
  HealthStatusSchema,
  ModelInfoSchema,
  MODALITIES,
  SidecarSynthesizeRequestSchema,
  TextCapabilitiesSchema,
  SttCapabilitiesSchema,
  TtsCapabilitiesSchema,
  ImageCapabilitiesSchema,
  defaultSettings,
  isOfflineSafe,
  isShowable,
  nextCycleStep,
  validateSettings,
  type Card,
  type EngineAdapter,
  type Modality,
} from '../src/index.js';
import { createFakeText } from '@understandity/engine-text-fake';
import { createFakeStt } from '@understandity/engine-stt-fake';
import { createFakeTts } from '@understandity/engine-tts-fake';
import { createFakeImage } from '@understandity/engine-image-fake';
import { createGeminiApiText } from '@understandity/engine-text-gemini-api';
import { createElevenLabsTts } from '@understandity/engine-tts-elevenlabs';

const root = resolve(import.meta.dirname, '../../..');
const readJson = (p: string) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const config = EnginesConfigSchema.parse(readJson('config/engines.json'));

describe('config/engines.json', () => {
  it('parses and its defaults are valid and offline', () => {
    const settings = defaultSettings(config);
    expect(settings.profile).toBe('offline');
    expect(validateSettings(settings, config)).toEqual([]);
  });

  it('every modality has a fake provider', () => {
    for (const m of MODALITIES) expect(config.providers[m].fake).toBeDefined();
  });

  it('cloud providers carry a secret env name and never a value', () => {
    for (const m of MODALITIES)
      for (const [id, p] of Object.entries(config.providers[m])) {
        if (p.locality === 'cloud') {
          expect(p.secretEnv, id).toMatch(/^[A-Z_]+$/);
          expect(p.enabled, `${id} must be off by default`).toBe(false);
        }
        expect(JSON.stringify(p.options)).not.toMatch(/sk[-_]|key=|token/i);
      }
  });

  it('Offline profile forbids cloud and non-loopback endpoints', () => {
    const base = defaultSettings(config);
    const withGemini = { ...base, engines: { ...base.engines, text: { provider: 'gemini-api', model: 'gemini-flash-latest', voice: null } } };
    const codes = validateSettings(withGemini, config).map((i) => i.code);
    expect(codes).toContain('offline_forbidden');
    expect(isOfflineSafe({ ...config.providers.text.ollama!, endpoint: 'http://192.168.1.5:11434' })).toBe(false);
    expect(isOfflineSafe(config.providers.text.ollama!)).toBe(true);
  });

  it('rejects unknown provider and model', () => {
    const base = defaultSettings(config);
    const bad = { ...base, engines: { ...base.engines, stt: { provider: 'nope', model: 'x', voice: null } } };
    expect(validateSettings(bad, config).map((i) => i.code)).toEqual(['unknown_provider']);
    const badModel = { ...base, engines: { ...base.engines, stt: { provider: 'fake', model: 'x', voice: null } } };
    expect(validateSettings(badModel, config).map((i) => i.code)).toEqual(['unknown_model']);
  });
});

describe('course schema', () => {
  const raw = readJson('content/demo-course.json');

  it('demo course parses', () => {
    const course = CourseSchema.parse(raw);
    expect(course.concepts[0]!.cards.length).toBeGreaterThanOrEqual(2);
  });

  it('key must answer the question of the same card', () => {
    const broken = structuredClone(raw);
    broken.concepts[0].cards[0].key.questionId = 'other-question';
    const res = CourseSchema.safeParse(broken);
    expect(res.success).toBe(false);
  });

  it('duplicate card ids are rejected', () => {
    const dup = structuredClone(raw);
    dup.concepts[0].cards[1].id = dup.concepts[0].cards[0].id;
    expect(CourseSchema.safeParse(dup).success).toBe(false);
  });

  it('only approved cards are showable unless drafts are explicitly allowed; blocked never', () => {
    const card = CourseSchema.parse(raw).concepts[0]!.cards[0]!;
    const withState = (state: Card['review']['state']): Card => ({ ...card, review: { ...card.review, state } });
    expect(isShowable(withState('approved'))).toBe(true);
    expect(isShowable(withState('needs_review'))).toBe(false);
    expect(isShowable(withState('needs_review'), { allowDrafts: true })).toBe(true);
    expect(isShowable(withState('blocked'), { allowDrafts: true })).toBe(false);
  });
});

describe('learning cycle', () => {
  it('goes hook → predict → explain → act → transfer → feedback', () => {
    expect(CYCLE_STEPS).toEqual(['hook', 'predict', 'explain', 'act', 'transfer', 'feedback']);
    expect(nextCycleStep('transfer')).toBe('feedback');
    expect(nextCycleStep('feedback')).toBeNull();
  });
});

describe('errors', () => {
  it('EngineError serialises to the payload schema with retryable defaults', () => {
    const e = new EngineError('no_speech', 'silence', { modality: 'stt', provider: 'fake' });
    expect(EngineErrorPayloadSchema.parse(e.toPayload())).toMatchObject({ code: 'no_speech', retryable: true });
    expect(new EngineError('offline_forbidden', 'x').retryable).toBe(false);
  });
});

describe('every adapter honours the base contract', () => {
  const capSchema: Record<Modality, { parse: (v: unknown) => unknown }> = {
    text: TextCapabilitiesSchema,
    stt: SttCapabilitiesSchema,
    tts: TtsCapabilitiesSchema,
    image: ImageCapabilitiesSchema,
  };
  const cases: [Modality, string, EngineAdapter][] = [
    ['text', 'fake', createFakeText(config.providers.text.fake!, { providerId: 'fake' })],
    ['stt', 'fake', createFakeStt(config.providers.stt.fake!, { providerId: 'fake' })],
    ['tts', 'fake', createFakeTts(config.providers.tts.fake!, { providerId: 'fake' })],
    ['image', 'fake', createFakeImage(config.providers.image.fake!, { providerId: 'fake' })],
    ['text', 'gemini-api', createGeminiApiText(config.providers.text['gemini-api']!, { providerId: 'gemini-api' })],
    ['tts', 'elevenlabs', createElevenLabsTts(config.providers.tts.elevenlabs!, { providerId: 'elevenlabs' })],
  ];
  for (const [modality, id, adapter] of cases) {
    it(`${modality}/${id}`, async () => {
      expect(adapter.modality).toBe(modality);
      expect(adapter.provider).toBe(id);
      HealthStatusSchema.parse(await adapter.health());
      for (const m of await adapter.listModels()) ModelInfoSchema.parse(m);
      capSchema[modality].parse(adapter.capabilities());
    });
  }

  it('cloud placeholders fail explicitly, not silently', async () => {
    const tts = createElevenLabsTts(config.providers.tts.elevenlabs!, { providerId: 'elevenlabs' });
    await expect(tts.synthesize({ model: 'eleven_multilingual_v2', text: 'hi', language: 'en' })).rejects.toMatchObject({ code: 'not_implemented' });
    expect(tts.capabilities().sendsTextToCloud).toBe(true);
  });
});

describe('sidecar contract', () => {
  it('tts-mlx request defaults sample rate', () => {
    expect(SidecarSynthesizeRequestSchema.parse({ text: 'Привет', language: 'ru', voice: 'Aiden' }).sampleRateHz).toBe(24000);
  });
});
