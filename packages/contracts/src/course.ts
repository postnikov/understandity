import { z } from 'zod';
import { LanguageSchema } from './common.js';

/**
 * Course → concepts → cards. Every card carries the chain the tutor needs:
 * fact (verified claim) → question (spoken by the student) → key (for the tutor only) → rubric (how to judge evidence).
 * A model may draft all of it, but nothing reaches a child before an adult review (see `ReviewStatus`).
 */

export const ReviewStateSchema = z.enum([
  'draft', // generated, nobody looked
  'needs_review', // model or validator flagged a doubt
  'approved', // adult checked cause, boundary case and every question→key pair
  'blocked', // contradiction in key or unverified fact — must not be shown
]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export const ReviewStatusSchema = z.object({
  state: ReviewStateSchema,
  reviewer: z.string().nullable().default(null),
  reviewedAt: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
});
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase id with dashes');

export const FactSchema = z.object({
  /** The central causal claim of the card, in plain words. */
  statement: z.string().min(1),
  /** Conditions without which the claim is wrong ("uniform body", "same room for a long time"). */
  conditions: z.array(z.string()).default([]),
  /** Where an adult can verify it (textbook page, OpenStax section). Never invented by the model. */
  source: z.string().nullable().default(null),
});

export const HookSchema = z.object({
  /** Surprising but true question that opens the card. The answer is not revealed here. */
  question: z.string().min(1),
  /** Invitation to predict with a reason, answered by voice. */
  predictPrompt: z.string().min(1),
});

export const ActionSchema = z.object({
  /** One safe action or thought experiment: change exactly one condition. */
  instruction: z.string().min(1),
  changedCondition: z.string().min(1),
  constants: z.array(z.string()).default([]),
  thoughtExperiment: z.boolean().default(true),
});

export const WorldSceneSchema = z.object({
  /** Student's world id: `fantasy`, `anime`, `cyberpunk`, `sport`, ... */
  world: z.string().min(1),
  scene: z.string().min(1),
  /** Simple scheme for an illustration; prompt for the image engine, no text in picture. */
  illustration: z.string().min(1),
  /** Pre-rendered image under `/media`, if the build step made one. */
  image: z.string().nullable().default(null),
});

export const VoiceQuestionSchema = z.object({
  id: Id,
  /** New neutral situation that needs a prediction and a cause. 15–30 s spoken answer, no choices. */
  prompt: z.string().min(1),
  maxAnswerSec: z.number().int().positive().max(30).default(30),
});

export const KeySchema = z.object({
  /** Must equal `question.id` of the same card. */
  questionId: Id,
  /** What a causal answer must contain. */
  expectedCause: z.string().min(1),
  /** Acceptable refinements of conditions ("if the body is hollow…"). */
  acceptable: z.array(z.string()).default([]),
  /** Typical wrong reasoning to watch for. */
  typicalMistake: z.string().min(1),
  /** One clarifying question the tutor may ask. */
  followUp: z.string().min(1),
});

export const RubricLevelSchema = z.enum(['shows_cause', 'familiar_words_wrong_use', 'not_enough_yet', 'channel_problem']);

export const RubricSchema = z.object({
  /** Evidence the tutor looks for in the confirmed transcript. */
  criteria: z
    .array(
      z.object({
        level: RubricLevelSchema,
        example: z.string().min(1),
        tutorMove: z.string().min(1),
      }),
    )
    .min(1),
  /** We never judge accent, timbre, speed or eloquence. */
  ignore: z.array(z.string()).default(['accent', 'voice timbre', 'speech speed', 'wording style']),
});

export const CardSchema = z
  .object({
    id: Id,
    title: z.string().min(1),
    fact: FactSchema,
    hook: HookSchema,
    /** 40–60 words; metaphor separated from mechanism. */
    explanation: z.string().min(1),
    action: ActionSchema,
    worlds: z.array(WorldSceneSchema).min(1),
    question: VoiceQuestionSchema,
    key: KeySchema,
    rubric: RubricSchema,
    /** A natural question the child might ask the tutor about this card. */
    askTutor: z.string().min(1),
    review: ReviewStatusSchema,
  })
  .refine((c) => c.key.questionId === c.question.id, {
    message: 'key.questionId must match question.id of the same card',
    path: ['key', 'questionId'],
  });
export type Card = z.infer<typeof CardSchema>;

export const ConceptSchema = z.object({
  id: Id,
  title: z.string().min(1),
  /** One central causal relation of the concept and where it applies. */
  centralCause: z.string().min(1),
  conditions: z.array(z.string()).default([]),
  cards: z.array(CardSchema).min(1),
});
export type Concept = z.infer<typeof ConceptSchema>;

export const CourseSchema = z
  .object({
    id: Id,
    title: z.string().min(1),
    /** One line: what the student will be able to explain. */
    outcome: z.string().min(1),
    language: LanguageSchema,
    subject: z.string().min(1),
    ageRange: z.tuple([z.number().int(), z.number().int()]).default([12, 14]),
    concepts: z.array(ConceptSchema).min(1),
    review: ReviewStatusSchema,
    origin: z.object({
      generator: z.enum(['hand', 'fake', 'model']),
      model: z.string().nullable().default(null),
      createdAt: z.string(),
    }),
  })
  .superRefine((course, ctx) => {
    const seen = new Set<string>();
    course.concepts.forEach((concept, ci) =>
      concept.cards.forEach((card, ki) => {
        if (seen.has(card.id)) {
          ctx.addIssue({ code: 'custom', message: `duplicate card id ${card.id}`, path: ['concepts', ci, 'cards', ki, 'id'] });
        }
        seen.add(card.id);
      }),
    );
  });
export type Course = z.infer<typeof CourseSchema>;
export type CourseInput = z.input<typeof CourseSchema>;

/** A card may be shown to a child only after adult approval; the demo may opt into drafts explicitly. */
export function isShowable(card: Card, opts: { allowDrafts?: boolean } = {}): boolean {
  if (card.review.state === 'blocked') return false;
  if (card.review.state === 'approved') return true;
  return opts.allowDrafts === true;
}

export function findCard(course: Course, cardId: string): { concept: Concept; card: Card } | null {
  for (const concept of course.concepts) {
    const card = concept.cards.find((c) => c.id === cardId);
    if (card) return { concept, card };
  }
  return null;
}
