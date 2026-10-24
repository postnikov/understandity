import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TutorTurnReplySchema, type TutorTurnReply } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { createApp } from '../src/app.js';
import { REPO_ROOT, loadCourse } from '../src/config.js';
import { EngineHub } from '../src/engines.js';
import { PROVIDERS } from '../src/providers.js';
import { countsAsHint, verdictFilter } from '../src/tutor.js';
import { tutorPrompt } from '../src/tutor-prompt.js';
import { fakeEnginesConfig } from './helpers.js';

function makeApp() {
  const contentDir = mkdtempSync(join(tmpdir(), 'ud-tutor-'));
  cpSync(resolve(REPO_ROOT, 'content'), contentDir, { recursive: true });
  const hub = new EngineHub(fakeEnginesConfig(), PROVIDERS, createDispatcher());
  return createApp({ hub, course: loadCourse(), allowDrafts: false, contentDir });
}

async function ask(app: ReturnType<typeof makeApp>, studentText: string, extra: Record<string, unknown> = {}): Promise<TutorTurnReply> {
  const res = await app.request('/api/tutor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ courseId: 'heavy-things-sink', cardId: 'c1-weight-vs-density', step: 'predict', world: 'fantasy', language: 'en', studentText, ...extra }),
  });
  expect(res.status).toBe(200);
  return TutorTurnReplySchema.parse(await res.json());
}

describe('tutor: hints are counted only when a hint was really given', () => {
  it('a correct answer is not a hint, and many correct answers never force a direct explanation', async () => {
    const app = makeApp();
    let hintsUsed = 0;
    for (let i = 0; i < 4; i++) {
      const r = await ask(app, 'It still sinks, the density per cube stays the same.', { hintsUsed });
      expect(r.hintGiven).toBe(false);
      expect(r.next).toBe('deeper');
      expect(r.evidence?.cause).toBe('correct');
      if (r.hintGiven) hintsUsed++;
    }
    expect(hintsUsed).toBe(0);
  });

  it('a wrong answer gets a guiding hint and counts', async () => {
    const r = await ask(makeApp(), 'The half floats because it is lighter.');
    expect(r.hintGiven).toBe(true);
    expect(r.next).toBe('counterexample');
    expect(r.evidence?.cause).toBe('incorrect');
  });

  it('"I don\'t know" counts as a hint; the student\'s own question never does', async () => {
    const app = makeApp();
    expect((await ask(app, "I don't know")).hintGiven).toBe(true);
    const q = await ask(app, 'Why does a steel ship float?', { kind: 'question', hintsUsed: 5 });
    expect(q.hintGiven).toBe(false);
    expect(q.next).toBe('ask_why'); // a question is answered, not converted into a forced explanation
    expect(q.evidence).toBeNull();
  });

  it('after two real hints the next answer gets a direct explanation', async () => {
    const r = await ask(makeApp(), 'Because it is lighter', { hintsUsed: 2 });
    expect(r.next).toBe('direct_explanation');
    expect(r.hintGiven).toBe(true);
  });

  it('the VERDICT line never reaches the child, neither in the reply nor in the stream', async () => {
    const app = makeApp();
    const r = await ask(app, 'It still sinks, same density.');
    expect(r.text).not.toMatch(/VERDICT/i);
    const raw = await (
      await app.request('/api/tutor/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ courseId: 'heavy-things-sink', cardId: 'c1-weight-vs-density', step: 'predict', world: 'fantasy', language: 'en', studentText: 'lighter' }),
      })
    ).text();
    const deltas = raw.split('\n\n').filter((b) => b.startsWith('event: delta')).map((b) => JSON.parse(b.split('data: ')[1]!).text).join('');
    expect(deltas).not.toMatch(/VERDICT/i);
    expect(deltas.length).toBeGreaterThan(10);
  });
});

describe('verdictFilter', () => {
  it('strips a tag split across deltas and passes the rest live', () => {
    const out: string[] = [];
    const f = verdictFilter((t) => out.push(t));
    for (const d of ['VER', 'DICT: par', 'tial\n', 'Good ', 'start.']) f.push(d);
    expect(out.join('')).toBe('Good start.');
    expect(f.finish('VERDICT: partial\nGood start.')).toEqual({ text: 'Good start.', verdict: 'partial' });
  });

  it('a reply without a tag is passed through untouched with verdict null', () => {
    const out: string[] = [];
    const f = verdictFilter((t) => out.push(t));
    for (const d of ['Very ', 'good.']) f.push(d);
    expect(out.join('')).toBe('Very good.');
    expect(f.finish('Very good.').verdict).toBeNull();
  });

  it('countsAsHint', () => {
    expect(countsAsHint('answer', 'correct')).toBe(false);
    expect(countsAsHint('answer', null)).toBe(false);
    expect(countsAsHint('answer', 'partial')).toBe(true);
    expect(countsAsHint('question', 'wrong')).toBe(false);
    expect(countsAsHint('explain_please', 'none')).toBe(true);
  });
});

describe('tutor prompt', () => {
  it('asks to confirm a correct cause and to judge by meaning', async () => {
    const course = JSON.parse((await import('node:fs')).readFileSync(resolve(REPO_ROOT, 'content/heavy-things-sink.json'), 'utf8'));
    const card = course.concepts[0].cards[0];
    const p = tutorPrompt(card, { language: 'en', world: 'fantasy', step: 'predict' }, 'answer');
    expect(p).toMatch(/VERDICT: correct/);
    expect(p).toMatch(/confirming plainly that they are right/);
    expect(p).toMatch(/by meaning, not by words/);
    expect(p).toMatch(/correct prediction with no reason is ALWAYS partial/);
    expect(p).toMatch(/never state the key or the cause yourself/);
    expect(p).toContain(card.key.expectedCause);
  });
});
