import { z } from 'zod';
import { CourseSchema, EngineError, collectText, type ChatMessage, type Course, type TextResult } from '@understandity/contracts';
import { extractJson } from './generator.js';
import { WORLD_SCENE_SHAPE, buildRepairPrompt, languageName, worldsInstruction } from './prompt.js';
import { markRevised } from './review.js';
import type { CourseGenerationDeps, GenerationAttempt } from './types.js';

/**
 * Adds new worlds to an existing course: the local model rewrites each card's scene for the student's world
 * with the same world rules as course generation. Cause, conditions and the right answer must not change,
 * so the adult's approval stays; the addition is recorded in `review.notes`.
 */

const S = z.string().trim().min(1);
export const WorldsDraftSchema = z.object({
  cards: z.array(z.object({ id: S, worlds: z.array(z.object({ world: S, scene: S, illustration: S })).min(1) })).min(1),
});
type WorldsDraft = z.infer<typeof WorldsDraftSchema>;

export function buildWorldsPrompt(course: Course, worlds: string[]): { system: string; user: string } {
  const cards = course.concepts.flatMap((k) =>
    k.cards.map((c) => ({
      id: c.id,
      title: c.title,
      fact: c.fact.statement,
      conditions: c.fact.conditions,
      explanation: c.explanation,
      action: c.action.instruction,
      exampleScene: c.worlds[0] ? { world: c.worlds[0].world, scene: c.worlds[0].scene } : null,
    })),
  );
  const system = `You adapt a school micro-course for a student aged ${course.ageRange[0]}-${course.ageRange[1]} to new worlds. Write every learner-facing string in ${languageName(course.language)}. Return ONLY one JSON object, no Markdown, no comments, no reasoning.`;
  const user = `Course: ${course.title}
Central cause: ${course.concepts[0]?.centralCause ?? ''}

${worldsInstruction(worlds)}

For EVERY card below write one scene per world. Heroes and look change; the cause, the essential conditions and the right answer stay exactly as in the card. Keep the card's conditions literally: the same liquid (if the card says water, it is plain water, not a coolant or a chemical), the same materials and the same one changed condition. The scene must not contradict the explanation or turn a metaphor into the mechanism. The illustration is one concrete picture in this world, 1-2 sentences: the world's hero, the card's exact objects and what visibly happens to them (for example which one floats and which one lies on the bottom), so the cause can be seen. Objects and people only: no screens with numbers, formulas, charts or writing.

Cards:
${JSON.stringify(cards, null, 1)}

JSON shape (one entry per card id, in the same order):
{ "cards": [ { "id": "<card id>", "worlds": [ ${WORLD_SCENE_SHAPE} ] } ] }`;
  return { system, user };
}

export function parseWorlds(text: string, course: Course, worlds: string[]): { draft: WorldsDraft | null; problems: string[] } {
  const json = extractJson(text);
  if (json === null) return { draft: null, problems: ['output is not a JSON object (maybe cut off by the token limit)'] };
  const parsed = WorldsDraftSchema.safeParse(json);
  if (!parsed.success) return { draft: null, problems: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const problems: string[] = [];
  const byId = new Map(parsed.data.cards.map((c) => [c.id, c]));
  for (const card of course.concepts.flatMap((k) => k.cards)) {
    const got = byId.get(card.id);
    if (!got) {
      problems.push(`card "${card.id}" is missing`);
      continue;
    }
    const have = new Set(got.worlds.map((w) => w.world.toLowerCase()));
    const missing = worlds.filter((w) => !have.has(w.toLowerCase()));
    if (missing.length) problems.push(`card "${card.id}": missing world(s) ${missing.join(', ')}`);
  }
  return { draft: parsed.data, problems };
}

/** Pure merge: new scenes replace same-world scenes, `image` stays null until an illustration is rendered. */
export function mergeWorlds(course: Course, draft: WorldsDraft, worlds: string[], meta: { model: string; at?: Date }): Course {
  const next = structuredClone(course);
  const wanted = new Set(worlds.map((w) => w.toLowerCase()));
  const byId = new Map(draft.cards.map((c) => [c.id, c]));
  for (const concept of next.concepts) {
    for (const card of concept.cards) {
      const got = byId.get(card.id);
      if (!got) continue;
      const fresh = got.worlds
        .filter((w) => wanted.has(w.world.toLowerCase()))
        .map((w) => ({ world: w.world.toLowerCase(), scene: w.scene, illustration: w.illustration, image: null }));
      const added = fresh.map((w) => w.world);
      card.worlds = [...card.worlds.filter((w) => !added.includes(w.world)), ...fresh];
      const what = `scenes for world(s) ${added.join(', ')} written by ${meta.model}`;
      card.review.notes = card.review.notes.filter((n) => !n.endsWith(`: ${what}`));
      markRevised(card, what, { at: meta.at });
    }
  }
  return CourseSchema.parse(next);
}

export async function addWorlds(
  course: Course,
  worlds: string[],
  deps: CourseGenerationDeps,
): Promise<{ course: Course; attempts: GenerationAttempt[]; totalMs: number }> {
  const started = Date.now();
  const { system, user } = buildWorldsPrompt(course, worlds);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const ask = (msgs: ChatMessage[]): Promise<TextResult> => {
    const run = (signal?: AbortSignal) =>
      collectText(
        deps.text.stream(
          { model: deps.model, messages: msgs, maxTokens: deps.maxTokens ?? 6000, temperature: deps.temperature ?? 0.3, json: true, think: false },
          { signal: signal ?? deps.signal },
        ),
      );
    if (!deps.text.heavy) return run(deps.signal);
    return deps.dispatcher.run({ modality: 'text', owner: `${deps.text.provider}:${deps.model}`, label: 'course-worlds' }, run, {
      timeoutMs: deps.timeoutMs ?? 240_000,
      signal: deps.signal,
    });
  };

  const attempts: GenerationAttempt[] = [];
  let draft: WorldsDraft | null = null;
  let problems: string[] = [];
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const msgs: ChatMessage[] =
      attempt === 0 ? messages : [...messages, { role: 'assistant', content: last }, { role: 'user', content: buildRepairPrompt(last, problems) }];
    const result = await ask(msgs);
    last = result.text;
    const parsed = parseWorlds(result.text, course, worlds);
    attempts.push({ ms: Date.now() - t0, usage: result.usage, problems: parsed.problems });
    if (parsed.draft) draft = parsed.draft;
    problems = parsed.problems;
    if (parsed.draft && parsed.problems.length === 0) break;
  }
  if (!draft || problems.length) {
    throw new EngineError('internal', `adding worlds failed after repair: ${problems.join('; ')}`, { modality: 'text', provider: deps.text.provider });
  }
  return { course: mergeWorlds(course, draft, worlds, { model: deps.model }), attempts, totalMs: Date.now() - started };
}
