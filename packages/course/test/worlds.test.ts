import { describe, expect, it } from 'vitest';
import { CourseSchema, EngineError, isShowable, type Course } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { addWorlds, buildImagePrompts, generateCourse, reviseCard, syncCourseReview, withoutNumbers, type MediaStyles } from '../src/index.js';
import { draftCourse, scriptedText } from './fixtures.js';

async function approvedCourse(): Promise<Course> {
  const { course } = await generateCourse(
    { topic: 't', language: 'en', ageRange: [12, 14], worlds: ['fantasy', 'anime'], cardCount: 2, id: 'heavy' },
    { text: scriptedText([JSON.stringify(draftCourse(2))]), model: 'fake', dispatcher: createDispatcher() },
  );
  for (const c of course.concepts[0]!.cards) c.review = { state: 'approved', reviewer: 'Max', reviewedAt: 'x', notes: [] };
  course.review.state = 'approved';
  return course;
}

const worldsOutput = (course: Course, worlds: string[]) =>
  JSON.stringify({
    cards: course.concepts[0]!.cards.map((c) => ({
      id: c.id,
      worlds: worlds.map((w) => ({ world: w, scene: `A hero in ${w}, mass 400 g, near water.`, illustration: `Block floats, stone on the bottom in ${w}.` })),
    })),
  });

describe('adding worlds to an approved course', () => {
  it('adds scenes, keeps approval and records the change in notes', async () => {
    const course = await approvedCourse();
    const text = scriptedText([worldsOutput(course, ['space', 'cyberpunk'])]);
    const res = await addWorlds(course, ['space', 'cyberpunk'], { text, model: 'gemma', dispatcher: createDispatcher() });
    for (const card of res.course.concepts[0]!.cards) {
      expect(card.worlds.map((w) => w.world)).toEqual(['fantasy', 'anime', 'space', 'cyberpunk']);
      expect(card.worlds.at(-1)!.image).toBeNull();
      expect(card.review.state).toBe('approved');
      expect(card.review.notes.at(-1)).toMatch(/изменено после одобрения: scenes for world\(s\) space, cyberpunk written by gemma/);
      expect(isShowable(card)).toBe(true);
    }
    expect(text.requests[0]!.messages.at(-1)!.content).toMatch(/gravity and air work as on Earth/);
    expect(text.requests[0]!.messages.at(-1)!.content).toMatch(/plain water, not a coolant/);
  });

  it('repairs once when a card or a world is missing, then fails loudly', async () => {
    const course = await approvedCourse();
    const partial = JSON.stringify({ cards: [{ id: course.concepts[0]!.cards[0]!.id, worlds: [{ world: 'space', scene: 's', illustration: 'i' }] }] });
    const text = scriptedText([partial, partial]);
    await expect(addWorlds(course, ['space'], { text, model: 'gemma', dispatcher: createDispatcher() })).rejects.toBeInstanceOf(EngineError);
    expect(text.requests).toHaveLength(2);
    expect(text.requests[1]!.messages.at(-1)!.content).toMatch(/is missing/);
  });

  it('a second pass replaces the scenes and does not pile up the same note', async () => {
    const course = await approvedCourse();
    const once = await addWorlds(course, ['space'], { text: scriptedText([worldsOutput(course, ['space'])]), model: 'gemma', dispatcher: createDispatcher() });
    const twice = await addWorlds(once.course, ['space'], { text: scriptedText([worldsOutput(course, ['space'])]), model: 'gemma', dispatcher: createDispatcher() });
    const card = twice.course.concepts[0]!.cards[0]!;
    expect(card.worlds.filter((w) => w.world === 'space')).toHaveLength(1);
    expect(card.review.notes.filter((n) => n.includes('scenes for world(s) space'))).toHaveLength(1);
  });
});

describe('revising cards through the adult gate', () => {
  it('predict/act edits keep approval with a note; question/key edits send the card back to review', async () => {
    const course = await approvedCourse();
    const [a, b] = course.concepts[0]!.cards;
    const ra = reviseCard(a!, { predictPrompt: 'Guess, and say why.', changedCondition: 'size: big → small' }, { why: 'kid language' });
    expect(ra.reapproval).toBe(false);
    expect(a!.review.state).toBe('approved');
    expect(a!.review.notes.at(-1)).toMatch(/изменено после одобрения: predict \(было: .*\); changedCondition .* — kid language/);

    const rb = reviseCard(b!, { questionPrompt: 'A new case?', key: { expectedCause: 'New cause.' } });
    expect(rb.reapproval).toBe(true);
    expect(b!.review).toMatchObject({ state: 'needs_review', reviewer: null });
    expect(b!.key.questionId).toBe(b!.question.id);
    expect(isShowable(b!)).toBe(false);

    syncCourseReview(course);
    expect(course.review.state).toBe('needs_review');
    expect(() => CourseSchema.parse(course)).not.toThrow();
  });

  it('unchanged values are not recorded', async () => {
    const course = await approvedCourse();
    const a = course.concepts[0]!.cards[0]!;
    const r = reviseCard(a, { predictPrompt: a.hook.predictPrompt, questionPrompt: a.question.prompt });
    expect(r).toMatchObject({ reapproval: false, changed: [] });
    expect(a.review.notes).toEqual([]);
  });
});

describe('illustration prompts', () => {
  const styles: MediaStyles = {
    preset: 'landscape',
    noText: 'No text.',
    worlds: { space: 'Space style.', cyberpunk: 'Neon style.' },
    courses: { heavy: 'Split view.' },
  };

  it('builds one prompt per card × world with paths, seeds and no measured numbers', async () => {
    const course = await approvedCourse();
    const withWorlds = (await addWorlds(course, ['space', 'cyberpunk'], { text: scriptedText([worldsOutput(course, ['space', 'cyberpunk'])]), model: 'g', dispatcher: createDispatcher() })).course;
    const out = buildImagePrompts(withWorlds, ['space', 'cyberpunk'], styles, 131);
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.seed)).toEqual([131, 132, 133, 134]);
    const card = withWorlds.concepts[0]!.cards[0]!;
    expect(out[0]).toMatchObject({ course: 'heavy', world: 'space', preset: 'landscape', image: `/media/heavy/${card.id}-space.png` });
    expect(out[0]!.prompt).toBe('A hero in space, near water. Block floats, stone on the bottom in space. Split view. Space style. No text.');
  });

  it('withoutNumbers drops the clause with numbers', () => {
    expect(withoutNumbers('An astronaut compares two objects, one with a density of 0.8 g/cm3 and one with 1.5 g/cm3, in a tank of water.')).toBe(
      'An astronaut compares two objects, in a tank of water.',
    );
    expect(withoutNumbers('A 6x6 square of tiles')).toBe('A square of tiles');
  });
});
