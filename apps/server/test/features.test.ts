import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { loadFeatures } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { DRAFT_COURSE_FILE, draftCourse, fakeEnginesConfig } from './helpers.js';

const post = (b: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

function app(adultCheck: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ud-feat-'));
  writeFileSync(join(dir, 'demo-course.json'), JSON.stringify(draftCourse()));
  const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher());
  return createApp({ hub, course: draftCourse(), allowDrafts: false, contentDir: dir, adultCheck });
}
const turn = { courseId: 'floating-density', cardId: 'half-block', step: 'predict', world: 'fantasy', language: 'ru', studentText: 'утонет' };

describe('adult check flag (config/features.json)', () => {
  it('this build ships with the adult check off', () => {
    expect(loadFeatures().adultCheck).toBe(false);
  });

  it('a missing or broken features file keeps the gate on', () => {
    expect(loadFeatures('/nonexistent/features.json').adultCheck).toBe(true);
    const f = join(mkdtempSync(join(tmpdir(), 'ud-feat-')), 'features.json');
    writeFileSync(f, '{oops');
    expect(loadFeatures(f).adultCheck).toBe(true);
    expect(DRAFT_COURSE_FILE).toMatch(/draft-course\.json$/);
  });

  it('gate off: the tutor works with an unreviewed card; gate on: it refuses', async () => {
    expect((await app(false).request('/api/tutor', post(turn))).status).toBe(200);
    expect((await app(true).request('/api/tutor', post(turn))).status).toBe(400);
  });
});
