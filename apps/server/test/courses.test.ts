import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CourseSchema, type Course } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { loadCourse } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { fakeEnginesConfig } from './helpers.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ud-courses-'));
  const demo = loadCourse();
  // file name differs from the id on purpose: the id inside is the key
  writeFileSync(join(dir, 'some-file.json'), JSON.stringify(demo));
  writeFileSync(join(dir, 'not-a-course.json'), '{"hello": 1}');
  process.env.UNDERSTANDITY_CONTENT_DIR = dir;
  const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher());
  const app = createApp({ hub, course: demo, allowDrafts: true });
  return { dir, app, demo };
}

const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

afterEach(() => {
  delete process.env.UNDERSTANDITY_CONTENT_DIR;
});

describe('adult review gate: /api/courses', () => {
  it('lists courses with pending review counts and skips non-course json', async () => {
    const { app, demo } = setup();
    const list = await (await app.request('/api/courses')).json();
    const total = demo.concepts.flatMap((k) => k.cards).length;
    expect(list).toEqual([expect.objectContaining({ id: demo.id, title: demo.title, lang: demo.language, cards: total, pendingReview: total })]);
  });

  it('returns the full course for the adult and nothing showable for the child before review', async () => {
    const { app, demo } = setup();
    const full = CourseSchema.parse(await (await app.request(`/api/courses/${demo.id}`)).json());
    expect(full.concepts.flatMap((k) => k.cards).length).toBeGreaterThan(0);
    const child = await (await app.request(`/api/courses/${demo.id}/showable`)).json();
    expect(child.concepts).toEqual([]);
  });

  it('approve with edits writes the file; the child sees only approved cards; blocked stays hidden', async () => {
    const { app, demo, dir } = setup();
    const [first, second] = demo.concepts.flatMap((k) => k.cards);
    const res = await app.request(
      `/api/courses/${demo.id}/review`,
      post({ cardId: first!.id, status: 'approved', edits: { fact: 'Edited fact.', key: 'Edited key.' }, reviewer: 'Max', note: 'checked against OpenStax' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.card.review).toMatchObject({ state: 'approved', reviewer: 'Max' });
    expect(body.card.fact.statement).toBe('Edited fact.');
    expect(body.card.key.expectedCause).toBe('Edited key.');
    expect(body.card.review.notes.join(' ')).toMatch(/fact edited \(was: /);

    await app.request(`/api/courses/${demo.id}/review`, post({ cardId: second!.id, status: 'blocked' }));

    const onDisk: Course = CourseSchema.parse(JSON.parse(readFileSync(join(dir, 'some-file.json'), 'utf8')));
    const cards = onDisk.concepts.flatMap((k) => k.cards);
    expect(cards.find((c) => c.id === first!.id)!.review.state).toBe('approved');
    expect(cards.find((c) => c.id === second!.id)!.review.state).toBe('blocked');

    const child: Course = await (await app.request(`/api/courses/${demo.id}/showable`)).json();
    expect(child.concepts.flatMap((k) => k.cards).map((c) => c.id)).toEqual([first!.id]);

    const list = await (await app.request('/api/courses')).json();
    expect(list[0]).toMatchObject({ approved: 1, blocked: 1, pendingReview: cards.length - 2 });
  });

  it('course review becomes approved when every card is decided', async () => {
    const { app, demo } = setup();
    for (const card of demo.concepts.flatMap((k) => k.cards)) {
      await app.request(`/api/courses/${demo.id}/review`, post({ cardId: card.id, status: 'approved' }));
    }
    const full = CourseSchema.parse(await (await app.request(`/api/courses/${demo.id}`)).json());
    expect(full.review.state).toBe('approved');
  });

  it('rejects bad input: unknown course, unknown card, bad status', async () => {
    const { app, demo } = setup();
    expect((await app.request('/api/courses/nope')).status).toBe(400);
    const unknownCard = await app.request(`/api/courses/${demo.id}/review`, post({ cardId: 'nope', status: 'approved' }));
    expect(unknownCard.status).toBe(400);
    expect((await unknownCard.json()).error.message).toMatch(/card "nope" not found/);
    const badStatus = await app.request(`/api/courses/${demo.id}/review`, post({ cardId: 'x', status: 'maybe' }));
    expect(badStatus.status).toBe(400);
  });
});
