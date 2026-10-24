import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { REPO_ROOT, loadCourse } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { fakeEnginesConfig } from './helpers.js';

describe('scene pictures not drawn yet', () => {
  it('a /media path without a file is sent as null; an existing file keeps its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-media-'));
    cpSync(resolve(REPO_ROOT, 'content/heavy-things-sink.json'), join(dir, 'heavy-things-sink.json'));
    mkdirSync(join(dir, 'media/heavy-things-sink'), { recursive: true });
    writeFileSync(join(dir, 'media/heavy-things-sink/c1-weight-vs-density-fantasy.png'), 'png');
    const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher());
    const app = createApp({ hub, course: loadCourse(), allowDrafts: false, contentDir: dir });
    const course = await (await app.request('/api/courses/heavy-things-sink')).json();
    const cards = course.concepts.flatMap((k: { cards: unknown[] }) => k.cards) as Array<{ worlds: Array<{ image: string | null }> }>;
    expect(cards[0]!.worlds[0]!.image).toBe('/media/heavy-things-sink/c1-weight-vs-density-fantasy.png');
    expect(cards[1]!.worlds[0]!.image).toBeNull(); // its PNG is not in this temp content dir
  });
});
