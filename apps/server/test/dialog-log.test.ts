import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { loadCourse } from '../src/config.js';
import { DialogLog } from '../src/dialog-log.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { fakeEnginesConfig } from './helpers.js';

function makeApp(enabled = true) {
  const dir = join(mkdtempSync(join(tmpdir(), 'ud-log-')), 'logs');
  const log = new DialogLog(dir, enabled);
  const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher());
  return { log, dir, app: createApp({ hub, course: loadCourse(), allowDrafts: true, dialogLog: log }) };
}
const post = (b: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const SESSION = '11111111-2222-4333-8444-555555555555';
const turn = { sessionId: SESSION, courseId: 'heavy-things-sink', cardId: 'c1-weight-vs-density', step: 'predict', world: 'fantasy', language: 'en', studentText: 'It still sinks, same density.', clientTimings: { sttMs: 812.4 } };
const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('dialog log (data/logs/tutor-<date>.jsonl)', () => {
  it('writes one turn line and one voice line sharing a turnId', async () => {
    const { app, log } = makeApp();
    const reply = await (await app.request('/api/tutor', post(turn))).json();
    expect(reply.turnId).toMatch(/^[0-9a-f-]{36}$/);
    const tts = await app.request(`/api/tts?turn=${reply.turnId}`, post({ text: reply.text, language: 'en' }));
    expect(tts.status).toBe(200);
    const [t, v] = lines(log.file());
    expect(t).toMatchObject({
      type: 'turn', turnId: reply.turnId, sessionId: SESSION, courseId: 'heavy-things-sink', cardId: 'c1-weight-vs-density', step: 'predict', kind: 'answer',
      student: 'It still sinks, same density.', tutor: reply.text, verdict: 'correct', hintGiven: false, provider: 'fake', model: 'fake-tutor',
      profile: 'offline', sttMs: 812, error: null,
    });
    expect(typeof t.firstPhraseMs).toBe('number');
    expect(typeof t.tutorMs).toBe('number');
    expect(v).toMatchObject({ type: 'voice', turnId: reply.turnId, sessionId: SESSION, provider: 'fake', model: 'fake-tts', error: null });
    expect(typeof v.ttsMs).toBe('number');
    expect(Object.keys(t).sort()).toEqual(['at', 'cardId', 'courseId', 'error', 'firstPhraseMs', 'hintGiven', 'kind', 'language', 'model', 'next', 'profile', 'provider', 'sessionId', 'step', 'student', 'sttMs', 'turnId', 'tutor', 'tutorMs', 'type', 'verdict', 'world'].sort());
    expect(statSync(log.file()).mode & 0o777).toBe(0o600);
  });

  it('the streaming route logs too, and its done event carries the turnId', async () => {
    const { app, log } = makeApp();
    const raw = await (await app.request('/api/tutor/stream', post({ ...turn, clientTimings: undefined }))).text();
    const done = JSON.parse(raw.split('\n\n').find((b) => b.startsWith('event: done'))!.split('data: ')[1]!);
    const [t] = lines(log.file());
    expect(t.turnId).toBe(done.turnId);
    expect(t.sttMs).toBeNull();
  });

  it('a failed turn is logged with its error code', async () => {
    const { app, log } = makeApp();
    expect((await app.request('/api/tutor', post({ ...turn, cardId: 'nope' }))).status).toBe(400);
    expect(lines(log.file())[0]).toMatchObject({ type: 'turn', error: 'bad_input', tutor: null });
  });

  it('a missing or malformed session id is logged as null, never as given', async () => {
    const { app, log } = makeApp();
    await app.request('/api/tutor', post({ ...turn, sessionId: undefined }));
    await app.request('/api/tutor', post({ ...turn, sessionId: '../../etc/passwd' }));
    expect(lines(log.file()).map((l) => l.sessionId)).toEqual([null, null]);
  });

  it('a voice request without a valid turn id writes nothing; a disabled log writes nothing', async () => {
    const { app, dir } = makeApp(false);
    await app.request('/api/tutor', post(turn));
    await app.request('/api/tts?turn=../../etc', post({ text: 'hi', language: 'en' }));
    expect(() => readdirSync(dir)).toThrow();
  });
});
