import { describe, expect, it } from 'vitest';
import { CourseSchema, EngineError, isShowable } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { buildPrompt, generateCourse, slugify, softChecks } from '../src/index.js';
import { draftCard, draftCourse, scriptedText } from './fixtures.js';

const REQ = {
  topic: 'Do heavy things always sink? Density and floating.',
  language: 'en',
  ageRange: [12, 14] as [number, number],
  worlds: ['fantasy', 'anime'],
  cardCount: 3,
  sourceNotes: 'Density is mass per unit volume.',
  source: { label: 'OpenStax University Physics 14.4', url: 'https://openstax.org/books/university-physics-volume-1/pages/14-4-archimedes-principle-and-buoyancy' },
  id: 'heavy-things-sink',
  subject: 'physics',
};

describe('course generator on a scripted fake engine', () => {
  it('turns a valid draft into a schema-valid course where nothing is showable yet', async () => {
    const text = scriptedText([JSON.stringify(draftCourse(3))]);
    const { course, report } = await generateCourse(REQ, { text, model: 'fake-tutor', dispatcher: createDispatcher() });

    expect(() => CourseSchema.parse(course)).not.toThrow();
    expect(course.id).toBe('heavy-things-sink');
    expect(course.origin).toMatchObject({ generator: 'model', model: 'fake-tutor' });
    const cards = course.concepts.flatMap((k) => k.cards);
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.review.state).toBe('needs_review');
      expect(card.key.questionId).toBe(card.question.id);
      expect(card.fact.source).toContain('openstax.org');
      expect(card.rubric.criteria.map((c) => c.level)).toEqual(['shows_cause', 'familiar_words_wrong_use', 'not_enough_yet', 'channel_problem']);
      expect(isShowable(card)).toBe(false);
    }
    expect(new Set(cards.map((c) => c.id)).size).toBe(3);
    expect(report.attempts).toHaveLength(1);

    const req = text.requests[0]!;
    expect(req.json).toBe(true);
    expect(req.think).toBe(false);
    expect(req.messages.at(-1)!.content).toContain('Density is mass per unit volume.');
  });

  it('repairs once when the first output is broken', async () => {
    const text = scriptedText(['{"title": "cut off by the token li', JSON.stringify(draftCourse(3))]);
    const { course, report } = await generateCourse(REQ, { text, model: 'fake-tutor', dispatcher: createDispatcher() });
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]!.problems[0]).toMatch(/not a JSON object/);
    expect(text.requests[1]!.messages.at(-1)!.content).toMatch(/did not pass validation/);
    expect(course.concepts[0]!.cards).toHaveLength(3);
  });

  it('asks for repair when card count or worlds are wrong, accepts with a note if still off', async () => {
    const short = draftCourse(2);
    const text = scriptedText([JSON.stringify(short), JSON.stringify(short)]);
    const { course, report } = await generateCourse(REQ, { text, model: 'fake-tutor', dispatcher: createDispatcher() });
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]!.problems).toContain('expected exactly 3 cards, got 2');
    expect(course.review.notes.join(' ')).toMatch(/unresolved format issues/);
  });

  it('fails with EngineError after a failed repair', async () => {
    const text = scriptedText(['not json', '{"also": "wrong"}']);
    await expect(generateCourse(REQ, { text, model: 'fake-tutor', dispatcher: createDispatcher() })).rejects.toBeInstanceOf(EngineError);
  });

  it('runs a heavy engine through the dispatcher', async () => {
    const dispatcher = createDispatcher();
    const text = scriptedText([JSON.stringify(draftCourse(3))], true);
    const seen: string[] = [];
    const wrapped = {
      ...dispatcher,
      run: ((task, fn, opts) => (seen.push(task.owner), dispatcher.run(task, fn, opts))) as typeof dispatcher.run,
    };
    await generateCourse(REQ, { text, model: 'gemma4:12b-mlx', dispatcher: wrapped });
    expect(seen).toEqual(['fake:gemma4:12b-mlx']);
  });
});

describe('acceptance helpers', () => {
  it('flags absolutes, written answers, doubts and explanation length', () => {
    const card = {
      ...draftCard(1),
      explanation: 'Too short.',
      voiceQuestion: 'Write down which one always sinks.',
      needsAdultCheck: true,
      doubt: 'unsure about hollow bodies',
    };
    const notes = softChecks(card).join(' | ');
    expect(notes).toMatch(/explanation is 2 words/);
    expect(notes).toMatch(/absolute word "always"/);
    expect(notes).toMatch(/write or choose/);
    expect(notes).toMatch(/unsure about hollow bodies/);
  });

  it('flags recall questions and questions that repeat the hook', () => {
    const recall = softChecks({ ...draftCard(1), voiceQuestion: 'What are the three ingredients of photosynthesis?' }).join(' | ');
    expect(recall).toMatch(/recall/);
    const c = draftCard(2);
    const repeat = softChecks({ ...c, voiceQuestion: c.hook.question }).join(' | ');
    expect(repeat).toMatch(/repeats the hook/);
    expect(softChecks(draftCard(3)).join(' | ')).not.toMatch(/repeats the hook|recall/);
  });

  it('prompt carries notes, card count, worlds and the safety block', () => {
    const { system, user } = buildPrompt(REQ);
    expect(system).toMatch(/English/);
    expect(user).toMatch(/exactly 3 connected cards/);
    expect(user).toMatch(/fantasy: wizards.*; anime: /);
    expect(user).toMatch(/change exactly one condition/);
    expect(user).toMatch(/no fire, freezer/);
  });

  it('slugify keeps ids schema-safe', () => {
    expect(slugify('Do heavy things ALWAYS sink?')).toBe('do-heavy-things-always-sink');
    expect(slugify('Плотность')).toBe('');
  });
});
