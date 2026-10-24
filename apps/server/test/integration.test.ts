import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TutorTurnReplySchema } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { REPO_ROOT, loadCourse } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { DRAFT_COURSE_FILE, fakeEnginesConfig } from './helpers.js';

/** Copy of content/ in a temp dir, so reviews in tests never touch the real course files. */
function makeApp(allowDrafts = false) {
  const contentDir = mkdtempSync(join(tmpdir(), 'ud-content-'));
  cpSync(resolve(REPO_ROOT, 'content'), contentDir, { recursive: true });
  // The draft course is a fixture: live content changes when an adult approves cards in the gate.
  cpSync(DRAFT_COURSE_FILE, join(contentDir, 'demo-course.json'));
  const config = fakeEnginesConfig();
  const hub = new EngineHub(config, PROVIDERS, createDispatcher());
  return { contentDir, app: createApp({ hub, course: loadCourse(), allowDrafts, contentDir }) };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const turn = (over: Record<string, unknown> = {}) => ({
  courseId: 'heavy-things-sink',
  cardId: 'c1-weight-vs-density',
  step: 'predict',
  world: 'fantasy',
  language: 'en',
  studentText: 'It floats because it is lighter.',
  ...over,
});

describe('integration: tutor follows the chosen course and the adult gate', () => {
  it('tutors a card of the chosen course, not only the boot course', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/tutor', json(turn()));
    expect(res.status).toBe(200);
    TutorTurnReplySchema.parse(await res.json());
  });

  it('an approved key edit from the adult gate reaches the tutor at once', async () => {
    const { app } = makeApp();
    const edited = 'EDITED KEY: compare mass per unit of volume with water.';
    const review = await app.request(
      '/api/courses/heavy-things-sink/review',
      json({ cardId: 'c1-weight-vs-density', status: 'approved', edits: { key: edited } }),
    );
    expect(review.status).toBe(200);
    const res = await app.request('/api/tutor', json(turn({ kind: 'explain_please' })));
    const reply = TutorTurnReplySchema.parse(await res.json());
    expect(reply.text).toContain(edited);
  });

  it('refuses to tutor a card no adult approved (drafts off by default)', async () => {
    const { app } = makeApp(false);
    const res = await app.request('/api/tutor', json(turn({ courseId: 'floating-density', cardId: 'half-block' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not approved/);
  });

  it('streams the tutor turn as SSE: deltas then one done event', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/tutor/stream', json(turn()));
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const raw = await res.text();
    const events = raw
      .split('\n\n')
      .filter(Boolean)
      .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }));
    const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.text as string);
    const done = events.filter((e) => e.event === 'done');
    expect(deltas.length).toBeGreaterThan(1);
    expect(done).toHaveLength(1);
    expect(deltas.join('').trim()).toBe(TutorTurnReplySchema.parse(done[0]!.data).text);
  });

  it('stream reports engine errors as one error event', async () => {
    const { app } = makeApp();
    const raw = await (await app.request('/api/tutor/stream', json(turn({ cardId: 'nope' })))).text();
    expect(raw).toMatch(/event: error/);
    expect(raw).toMatch(/bad_input/);
  });

  it('serves pre-rendered scene images under /media', async () => {
    const { app, contentDir } = makeApp();
    mkdirSync(join(contentDir, 'media/heavy-things-sink'), { recursive: true });
    writeFileSync(join(contentDir, 'media/heavy-things-sink/c1-fantasy.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await app.request('/media/heavy-things-sink/c1-fantasy.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await app.request('/media/../config/engines.json')).status).toBe(404);
  });
});
