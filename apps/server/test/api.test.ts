import { describe, expect, it } from 'vitest';
import { CourseSchema, EnginesResponseSchema, TranscriptSchema, TutorTurnReplySchema } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { loadCourse } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { fakeEnginesConfig } from './helpers.js';

function makeApp() {
  const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher());
  return { hub, app: createApp({ hub, course: loadCourse(), allowDrafts: true }) };
}

describe('end-to-end path on fakes: card → record → transcript → tutor → voice', () => {
  it('runs the whole loop', async () => {
    const { app } = makeApp();

    const course = CourseSchema.parse(await (await app.request('/api/course')).json());
    const card = course.concepts[0]!.cards[0]!;

    const sttRes = await app.request('/api/stt?lang=ru', {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: new Uint8Array(32000),
    });
    expect(sttRes.status).toBe(200);
    const transcript = TranscriptSchema.parse(await sttRes.json());
    expect(transcript.text.length).toBeGreaterThan(0);

    const tutorRes = await app.request('/api/tutor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ courseId: course.id, cardId: card.id, step: 'predict', world: 'fantasy', language: 'ru', studentText: transcript.text }),
    });
    expect(tutorRes.status).toBe(200);
    const reply = TutorTurnReplySchema.parse(await tutorRes.json());
    expect(reply.text).toContain('?');

    const ttsRes = await app.request('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: reply.text }),
    });
    expect(ttsRes.status).toBe(200);
    expect(ttsRes.headers.get('content-type')).toBe('audio/wav');
    const wav = new Uint8Array(await ttsRes.arrayBuffer());
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
  });

  it('empty recording is "no answer", not a wrong answer', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/stt', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(0) });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('no_speech');
  });

  it('lists every configured provider with health and the dispatcher state', async () => {
    const { app } = makeApp();
    const body = EnginesResponseSchema.parse(await (await app.request('/api/engines')).json());
    expect(body.settings.profile).toBe('offline');
    const ids = body.providers.map((p) => `${p.modality}/${p.provider}`);
    expect(ids).toEqual(expect.arrayContaining(['text/fake', 'text/ollama', 'text/gemini-api', 'tts/elevenlabs', 'tts/mlx-qwen3']));
    expect(body.providers.find((p) => p.provider === 'gemini-api')?.offlineSafe).toBe(false);
  });

  it('Offline profile refuses cloud providers', async () => {
    const { app, hub } = makeApp();
    const s = hub.getSettings();
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...s, engines: { ...s.engines, tts: { provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice: null } } }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issues.map((i: { code: string }) => i.code)).toContain('offline_forbidden');
    expect(hub.getSettings().engines.tts.provider).toBe('fake');
  });
});
