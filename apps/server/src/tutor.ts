import {
  TutorTurnRequestSchema,
  findCard,
  isShowable,
  type Course,
  type NextMove,
  type TextResult,
  type TutorTurnReply,
  type TutorTurnRequest,
} from '@understandity/contracts';
import { EngineError } from '@understandity/contracts';
import type { EngineHub } from './engines.js';

/** Resolves a course by id at call time, so approved key edits from the adult gate reach the tutor at once. */
export type CourseLookup = (courseId: string) => Promise<Course | null>;

export interface TutorOptions {
  /** Same rule as the child screen: unreviewed cards are not tutored unless drafts are explicitly allowed. */
  allowDrafts: boolean;
  /** Called with every text delta while the engine streams. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * One tutor turn: card goal + key + rubric + recent dialogue → one short question or explanation.
 * Prompt and evidence extraction are still the skeleton: `evidence` is null, `next` is coarse.
 */
export async function tutorTurn(
  hub: EngineHub,
  lookup: CourseLookup,
  input: TutorTurnRequest,
  opts: TutorOptions,
): Promise<TutorTurnReply> {
  const req = TutorTurnRequestSchema.parse(input);
  const course = await lookup(req.courseId);
  if (!course) throw new EngineError('bad_input', `course "${req.courseId}" not found`);
  const found = findCard(course, req.cardId);
  if (!found) throw new EngineError('bad_input', `card "${req.cardId}" not found in "${req.courseId}"`);
  const { card } = found;
  if (!isShowable(card, { allowDrafts: opts.allowDrafts })) {
    throw new EngineError('bad_input', `card "${card.id}" is not approved by an adult yet`);
  }

  const system = [
    `You tutor a 12–14 year old. Answer in language: ${req.language}. Student's world: ${req.world}.`,
    `Card goal: ${card.fact.statement}`,
    card.fact.conditions.length ? `Conditions: ${card.fact.conditions.join('; ')}` : '',
    `Key (never reveal before the student tries): ${card.key.expectedCause}`,
    `Typical mistake: ${card.key.typicalMistake}`,
    `Good clarifying question: ${card.key.followUp}`,
    'Reply in 2–4 short sentences with exactly one question. Do not praise before the cause is checked. Never judge accent or wording style.',
    req.hintsUsed >= 2 ? 'Two hints were already given: explain directly on a different example, then ask for a new case.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system' as const, content: system },
    ...req.history.map((h) => ({ role: h.role === 'student' ? ('user' as const) : ('assistant' as const), content: h.text })),
    { role: 'user' as const, content: req.studentText },
  ];

  const kind = req.hintsUsed >= 2 ? 'explain_please' : req.kind;
  const result = await hub.run('text', `tutor ${card.id}`, async (text, model, signal): Promise<TextResult> => {
    const events = text.stream(
      {
        model,
        messages,
        maxTokens: 160,
        context: { kind, language: req.language, studentText: req.studentText, followUp: card.key.followUp, expectedCause: card.key.expectedCause, cardId: card.id },
      },
      { signal: signal ?? opts.signal },
    );
    for await (const ev of events) {
      if (ev.type === 'delta') opts.onDelta?.(ev.text);
      else return { text: ev.text, model: ev.model, usage: ev.usage };
    }
    throw new EngineError('internal', 'text stream ended without a done event', { modality: 'text' });
  });

  const next: NextMove = kind === 'explain_please' ? 'direct_explanation' : kind === 'question' ? 'ask_why' : 'counterexample';
  return { text: result.text.trim(), evidence: null, next, hintGiven: kind === 'answer', model: result.model };
}
