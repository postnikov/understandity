import { z } from 'zod';
import { LanguageSchema } from './common.js';
import { TranscriptSchema } from './adapters.js';

/**
 * One learning cycle of a card (2–3 min portion, not a deadline):
 * hook → predict (voice) → explain → act (change one condition) → transfer (voice, no hints) → feedback.
 * Any step may be interrupted by a question to the tutor.
 */
export const CycleStepSchema = z.enum(['hook', 'predict', 'explain', 'act', 'transfer', 'feedback']);
export type CycleStep = z.infer<typeof CycleStepSchema>;
export const CYCLE_STEPS = CycleStepSchema.options;

/** Steps where the student answers by voice. */
export const VOICE_STEPS: readonly CycleStep[] = ['predict', 'act', 'transfer'];

export function nextCycleStep(step: CycleStep): CycleStep | null {
  const i = CYCLE_STEPS.indexOf(step);
  return CYCLE_STEPS[i + 1] ?? null;
}

/** Channel failure is separated from understanding: a failed recording is "no answer", never "did not understand". */
export const ChannelIssueSchema = z.enum(['silence', 'noise', 'cutoff', 'unsupported_language', 'ambiguous_word', 'mic_unavailable']);
export type ChannelIssue = z.infer<typeof ChannelIssueSchema>;

export const VoiceAttemptSchema = z.object({
  step: CycleStepSchema,
  questionId: z.string(),
  transcript: TranscriptSchema.nullable(),
  /** Student confirmed "yes, that is what I said" (or edited/re-recorded). Only confirmed text is graded. */
  confirmed: z.boolean(),
  channelIssue: ChannelIssueSchema.nullable().default(null),
  at: z.string(),
});
export type VoiceAttempt = z.infer<typeof VoiceAttemptSchema>;

/** What the tutor extracted from a confirmed answer. Observations, not grades. */
export const EvidenceSchema = z.object({
  prediction: z.string().nullable(),
  cause: z.enum(['correct', 'incorrect', 'missing', 'unclear']),
  transfer: z.enum(['independent', 'with_hints', 'not_yet', 'unknown']),
  hintsUsed: z.number().int().nonnegative(),
  /** Quote from the transcript that supports the judgement. */
  quote: z.string().nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const NextMoveSchema = z.enum([
  'clarify_transcript', // "I heard: … — correct?"
  'ask_why', // prediction right, no cause
  'counterexample', // wrong cause → counterexample to exactly that cause
  'similar_without_hint', // solved only with hints
  'deeper', // cause + transfer independent → related concept / harder condition
  'other_metaphor', // retry with another world
  'direct_explanation', // after two failed hints or on "just explain"
  'change_world', // "boring" → change world, keep the goal
]);
export type NextMove = z.infer<typeof NextMoveSchema>;

export const OutcomeSchema = z.enum([
  'explained_new_case',
  'found_cause_after_hint',
  'needs_clarification',
  'no_usable_answer',
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** Minimal per-card state of the current pass. No profile, no diagnosis, no "learned forever". */
export const CardProgressSchema = z.object({
  cardId: z.string(),
  step: CycleStepSchema,
  world: z.string(),
  language: LanguageSchema,
  attempts: z.array(VoiceAttemptSchema).default([]),
  evidence: EvidenceSchema.nullable().default(null),
  hintsUsed: z.number().int().nonnegative().default(0),
  outcome: OutcomeSchema.nullable().default(null),
});
export type CardProgress = z.infer<typeof CardProgressSchema>;

/** One tutor turn under a card. */
export const TutorTurnRequestSchema = z.object({
  courseId: z.string(),
  cardId: z.string(),
  step: CycleStepSchema,
  world: z.string(),
  language: LanguageSchema,
  /** Confirmed transcript of the student's answer, or a typed question to the tutor. */
  studentText: z.string().min(1),
  kind: z.enum(['answer', 'question', 'explain_please']).default('answer'),
  hintsUsed: z.number().int().nonnegative().default(0),
  history: z.array(z.object({ role: z.enum(['student', 'tutor']), text: z.string() })).max(20).default([]),
});
export type TutorTurnRequest = z.input<typeof TutorTurnRequestSchema>;

export const TutorTurnReplySchema = z.object({
  /** One question or a short explanation, 2–4 sentences. */
  text: z.string().min(1),
  evidence: EvidenceSchema.nullable(),
  next: NextMoveSchema,
  hintGiven: z.boolean(),
  model: z.string(),
});
export type TutorTurnReply = z.infer<typeof TutorTurnReplySchema>;
