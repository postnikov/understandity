import { z } from 'zod';
import {
  CourseSchema,
  EngineError,
  collectText,
  type ChatMessage,
  type Course,
  type CourseInput,
  type TextResult,
} from '@understandity/contracts';
import { buildPrompt, buildRepairPrompt } from './prompt.js';
import type { CourseGenerationDeps, CourseGenerator, CourseRequest, GenerationAttempt, GenerationReport } from './types.js';

/* ------------------------------------------------------------------ */
/* What the model returns (smaller than CourseSchema: ids, review,     */
/* sources and rubric moves are added by code, never by the model)     */
/* ------------------------------------------------------------------ */

const S = z.string().trim().min(1);
const Strs = z.array(z.string()).default([]);

export const DraftCardSchema = z.object({
  title: S,
  fact: z.object({ statement: S, conditions: Strs }),
  hook: z.object({ question: S, predictPrompt: S }),
  explanation: S,
  action: z.object({ instruction: S, changedCondition: S, constants: Strs }),
  worlds: z.array(z.object({ world: S, scene: S, illustration: S })).min(1),
  voiceQuestion: S,
  key: z.object({ expectedCause: S, acceptable: Strs, typicalMistake: S, followUp: S }),
  rubric: z.object({ showsCause: S, wrongUse: S, notEnough: S }),
  askTutor: S,
  needsAdultCheck: z.boolean().default(false),
  doubt: z.string().nullable().default(null),
});
export type DraftCard = z.infer<typeof DraftCardSchema>;

export const DraftCourseSchema = z.object({
  title: S,
  outcome: S,
  centralCause: S,
  conditions: Strs,
  cards: z.array(DraftCardSchema).min(1),
});
export type DraftCourse = z.infer<typeof DraftCourseSchema>;

/* ------------------------------------------------------------------ */
/* Acceptance: hard problems → one repair; soft ones → review notes    */
/* ------------------------------------------------------------------ */

export function words(s: string): number {
  return s.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w)).length;
}

const STOP = new Set(['the', 'a', 'an', 'it', 'is', 'are', 'will', 'why', 'what', 'if', 'you', 'of', 'to', 'in', 'and', 'or', 'do', 'does', 'they', 'still', 'be']);
const bag = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)));

/** Share of the question's content words already present in `other` (0..1). */
export function similarity(question: string, other: string): number {
  const q = bag(question);
  const o = bag(other);
  if (q.size === 0) return 0;
  let hit = 0;
  for (const w of q) if (o.has(w)) hit++;
  return hit / q.size;
}

const RECALL = /^(what are|what is|name|list|define|what do we call|что такое|назови|перечисли)\b/iu;
const ABSOLUTES = /\b(always|never|only|impossible|all|none|всегда|никогда|только|невозможно)\b/iu;
const WRITTEN_ANSWER = /\b(write|choose|select|pick one|option [abc]|запиши|напиши|выбери)\b/iu;

/** Parse model text into a draft; returns problems that justify a repair round. */
export function parseDraft(text: string, req: CourseRequest): { draft: DraftCourse | null; problems: string[] } {
  const json = extractJson(text);
  if (json === null) return { draft: null, problems: ['output is not a JSON object (maybe cut off by the token limit)'] };
  const parsed = DraftCourseSchema.safeParse(json);
  if (!parsed.success) {
    return { draft: null, problems: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const draft = parsed.data;
  const problems: string[] = [];
  if (draft.cards.length !== req.cardCount) problems.push(`expected exactly ${req.cardCount} cards, got ${draft.cards.length}`);
  draft.cards.forEach((card, i) => {
    const have = new Set(card.worlds.map((w) => w.world.toLowerCase()));
    const missing = req.worlds.filter((w) => !have.has(w.toLowerCase()));
    if (missing.length) problems.push(`cards.${i}.worlds: missing world(s) ${missing.join(', ')}`);
  });
  return { draft, problems };
}

/** Formal checks from the note's acceptance gate. They never approve anything — they only add notes for the adult. */
export function softChecks(card: DraftCard): string[] {
  const notes: string[] = [];
  const ew = words(card.explanation);
  if (ew < 40 || ew > 60) notes.push(`explanation is ${ew} words (expected 40–60)`);
  const total = words(
    [card.hook.question, card.hook.predictPrompt, card.explanation, card.action.instruction, card.voiceQuestion, card.askTutor].join(' '),
  );
  if (total < 90 || total > 220) notes.push(`learner text is ${total} words (card target 130–190 incl. worlds)`);
  for (const [field, value] of [
    ['voice question', card.voiceQuestion],
    ['key', card.key.expectedCause],
    ['fact', card.fact.statement],
  ] as const) {
    const m = value.match(ABSOLUTES);
    if (m) notes.push(`absolute word "${m[0]}" in ${field} — check that it holds under the stated conditions`);
  }
  if (WRITTEN_ANSWER.test(card.voiceQuestion)) notes.push('voice question asks to write or choose — must be a spoken causal answer');
  if (RECALL.test(card.voiceQuestion.trim())) notes.push('voice question may ask for recall (list/define), not a prediction with a cause in a new situation');
  const overlap = similarity(card.voiceQuestion, `${card.hook.question} ${card.hook.predictPrompt} ${card.action.instruction}`);
  if (overlap >= 0.6) notes.push(`voice question repeats the hook/action (${Math.round(overlap * 100)}% word overlap) — transfer needs a new situation`);
  if (card.fact.conditions.length === 0) notes.push('fact has no conditions — check whether the claim needs any');
  if (card.needsAdultCheck) notes.push(`model flagged a doubt: ${card.doubt ?? '(no detail)'}`);
  return notes;
}

/* ------------------------------------------------------------------ */
/* Draft → Course                                                      */
/* ------------------------------------------------------------------ */

export function slugify(s: string, max = 48): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}

const MOVES: Record<string, { cause: string; wrong: string; channel: string; channelExample: string }> = {
  en: {
    cause: 'Confirm the cause, then give a new case without hints (transfer).',
    wrong: 'Return a counterexample and ask to compare again.',
    channel: 'Re-ask what was heard before judging; never grade accent or speed.',
    channelExample: 'Transcript is garbled or cut off.',
  },
  ru: {
    cause: 'Подтвердить причину и дать новую ситуацию без подсказки (перенос).',
    wrong: 'Вернуть контрпример и попросить сравнить ещё раз.',
    channel: 'Переспросить, что услышано, прежде чем оценивать; акцент и темп не оцениваем.',
    channelExample: 'Расшифровка обрывочная или искажена.',
  },
};

export function draftToCourse(draft: DraftCourse, req: CourseRequest, meta: { model: string; createdAt: string; extraNotes?: string[] }): Course {
  const moves = MOVES[req.language.split('-')[0] ?? ''] ?? MOVES.en!;
  const used = new Set<string>();
  const sourceLine = req.source ? (req.source.url ? `${req.source.label} — ${req.source.url}` : req.source.label) : null;
  const cards = draft.cards.map((c, i) => {
    let id = `c${i + 1}-${slugify(c.title, 32)}`.replace(/-+$/, '') || `c${i + 1}`;
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    const qid = `q-${id}`;
    const notes = softChecks(c);
    return {
      id,
      title: c.title,
      fact: { statement: c.fact.statement, conditions: c.fact.conditions, source: sourceLine },
      hook: c.hook,
      explanation: c.explanation,
      action: { ...c.action, thoughtExperiment: true },
      worlds: c.worlds.map((w) => ({ world: w.world.toLowerCase(), scene: w.scene, illustration: w.illustration, image: null })),
      question: { id: qid, prompt: c.voiceQuestion, maxAnswerSec: 30 },
      key: { questionId: qid, ...c.key },
      rubric: {
        criteria: [
          { level: 'shows_cause' as const, example: c.rubric.showsCause, tutorMove: moves.cause },
          { level: 'familiar_words_wrong_use' as const, example: c.rubric.wrongUse, tutorMove: moves.wrong },
          { level: 'not_enough_yet' as const, example: c.rubric.notEnough, tutorMove: c.key.followUp },
          { level: 'channel_problem' as const, example: moves.channelExample, tutorMove: moves.channel },
        ],
      },
      askTutor: c.askTutor,
      review: { state: 'needs_review' as const, reviewer: null, reviewedAt: null, notes },
    };
  });

  const input: CourseInput = {
    id: req.id ?? (slugify(draft.title) || 'course'),
    title: draft.title,
    outcome: draft.outcome,
    language: req.language,
    subject: req.subject ?? 'general',
    ageRange: req.ageRange,
    concepts: [
      {
        id: slugify(req.id ?? draft.title, 32) || 'concept',
        title: draft.title,
        centralCause: draft.centralCause,
        conditions: draft.conditions,
        cards,
      },
    ],
    review: {
      state: 'needs_review',
      reviewer: null,
      reviewedAt: null,
      notes: [
        `Generated by ${meta.model}; nothing is shown to a child before an adult approves each card (fact → question → key).`,
        ...(sourceLine ? [`Source for verification: ${sourceLine}`] : ['No verified source notes were supplied.']),
        ...(meta.extraNotes ?? []),
      ],
    },
    origin: { generator: 'model', model: meta.model, createdAt: meta.createdAt },
  };
  return CourseSchema.parse(input);
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function generateCourse(
  req: CourseRequest,
  deps: CourseGenerationDeps,
): Promise<{ course: Course; report: GenerationReport }> {
  const started = Date.now();
  const { system, user } = buildPrompt(req);
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const attempts: GenerationAttempt[] = [];

  const ask = async (msgs: ChatMessage[]): Promise<TextResult> => {
    const run = (signal?: AbortSignal) =>
      collectText(
        deps.text.stream(
          {
            model: deps.model,
            messages: msgs,
            maxTokens: deps.maxTokens ?? 6000,
            temperature: deps.temperature ?? 0.3,
            json: true,
            think: false,
            // Lets cloud engines pick course-sized limits and effort; local engines ignore it.
            context: { purpose: 'course' },
          },
          { signal: signal ?? deps.signal },
        ),
      );
    if (!deps.text.heavy) return run(deps.signal);
    return deps.dispatcher.run({ modality: 'text', owner: `${deps.text.provider}:${deps.model}`, label: 'course-generate' }, run, {
      timeoutMs: deps.timeoutMs ?? 240_000,
      signal: deps.signal,
    });
  };

  let draft: DraftCourse | null = null;
  let problems: string[] = [];
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const msgs: ChatMessage[] =
      attempt === 0 ? messages : [...messages, { role: 'assistant', content: last }, { role: 'user', content: buildRepairPrompt(last, problems) }];
    const result = await ask(msgs);
    last = result.text;
    const parsed = parseDraft(result.text, req);
    attempts.push({ ms: Date.now() - t0, usage: result.usage, problems: parsed.problems });
    if (parsed.draft) draft = parsed.draft;
    problems = parsed.problems;
    if (parsed.draft && parsed.problems.length === 0) break;
  }
  if (!draft) {
    throw new EngineError('internal', `course generation failed after repair: ${problems.join('; ')}`, { modality: 'text', provider: deps.text.provider });
  }

  const extraNotes = problems.length ? [`Accepted with unresolved format issues: ${problems.join('; ')}`] : [];
  const course = draftToCourse(draft, req, { model: deps.model, createdAt: new Date().toISOString(), extraNotes });
  const warnings = course.concepts.flatMap((k) => k.cards.flatMap((c) => c.review.notes.map((n) => `${c.id}: ${n}`)));
  return {
    course,
    report: { model: deps.model, provider: deps.text.provider, totalMs: Date.now() - started, attempts, warnings },
  };
}

export const localCourseGenerator: CourseGenerator = {
  async generate(req, deps) {
    return (await generateCourse(req, deps)).course;
  },
};
