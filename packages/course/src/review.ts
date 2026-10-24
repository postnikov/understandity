import { z } from 'zod';
import { CourseSchema, findCard, isShowable, type Course } from '@understandity/contracts';

/**
 * Adult review gate (contract for the UI, fixed by the course module):
 * `POST /api/courses/:id/review` with `{cardId, status: approved|blocked, edits?: {fact?, question?, key?}}`.
 * `edits.fact` replaces `fact.statement`, `edits.question` replaces `question.prompt`,
 * `edits.key` replaces `key.expectedCause`. A child sees only cards where `isShowable(card)` is true.
 */
export const ReviewRequestSchema = z.object({
  cardId: z.string().min(1),
  status: z.enum(['approved', 'blocked']),
  edits: z
    .object({
      fact: z.string().trim().min(1).optional(),
      question: z.string().trim().min(1).optional(),
      key: z.string().trim().min(1).optional(),
    })
    .optional(),
  reviewer: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export interface CourseSummary {
  id: string;
  title: string;
  lang: string;
  subject: string;
  review: Course['review']['state'];
  cards: number;
  /** Cards still waiting for an adult (draft or needs_review). */
  pendingReview: number;
  approved: number;
  blocked: number;
  source: string | null;
  model: string | null;
}

export function courseSummary(course: Course): CourseSummary {
  const cards = course.concepts.flatMap((k) => k.cards);
  const count = (s: string) => cards.filter((c) => c.review.state === s).length;
  return {
    id: course.id,
    title: course.title,
    lang: course.language,
    subject: course.subject,
    review: course.review.state,
    cards: cards.length,
    pendingReview: count('draft') + count('needs_review'),
    approved: count('approved'),
    blocked: count('blocked'),
    source: cards.find((c) => c.fact.source)?.fact.source ?? null,
    model: course.origin.model,
  };
}

/** Pure: returns a new course with the card reviewed. Throws `Error('card_not_found')` for an unknown card. */
export function applyReview(course: Course, req: ReviewRequest, now = new Date()): Course {
  const next = structuredClone(course);
  const hit = findCard(next, req.cardId);
  if (!hit) throw new Error('card_not_found');
  const { card } = hit;
  const at = now.toISOString();
  const who = req.reviewer ?? 'adult';
  const notes = [...card.review.notes];
  if (req.edits?.fact) {
    notes.push(`${at} ${who}: fact edited (was: ${card.fact.statement})`);
    card.fact.statement = req.edits.fact;
  }
  if (req.edits?.question) {
    notes.push(`${at} ${who}: question edited (was: ${card.question.prompt})`);
    card.question.prompt = req.edits.question;
  }
  if (req.edits?.key) {
    notes.push(`${at} ${who}: key edited (was: ${card.key.expectedCause})`);
    card.key.expectedCause = req.edits.key;
  }
  if (req.note) notes.push(`${at} ${who}: ${req.note}`);
  card.review = { state: req.status, reviewer: who, reviewedAt: at, notes };

  const all = next.concepts.flatMap((k) => k.cards);
  const done = all.every((c) => c.review.state === 'approved' || c.review.state === 'blocked');
  const anyApproved = all.some((c) => c.review.state === 'approved');
  next.review = {
    ...next.review,
    state: done ? (anyApproved ? 'approved' : 'blocked') : 'needs_review',
    reviewer: done ? who : next.review.reviewer,
    reviewedAt: done ? at : next.review.reviewedAt,
  };
  return CourseSchema.parse(next);
}

/** What a child may see: approved cards only (no drafts), concepts without cards dropped. */
export function showableCourse(course: Course): Course {
  return {
    ...course,
    concepts: course.concepts
      .map((k) => ({ ...k, cards: k.cards.filter((c) => isShowable(c, { allowDrafts: false })) }))
      .filter((k) => k.cards.length > 0),
  };
}

type Card = Course['concepts'][number]['cards'][number];

/**
 * Record a change that does not touch what the adult verifies (fact, question, key): approval stays,
 * the change is written into `review.notes` so the adult can see what moved after approval.
 */
export function markRevised(card: Card, what: string, opts: { at?: Date } = {}): void {
  const at = (opts.at ?? new Date()).toISOString();
  const prefix = card.review.state === 'approved' ? 'изменено после одобрения' : 'изменено';
  card.review.notes.push(`${at} ${prefix}: ${what}`);
}

/** Learner-facing edits of a card. Gated fields (fact, question, key) send the card back to `needs_review`. */
export interface CardPatch {
  hookQuestion?: string;
  predictPrompt?: string;
  explanation?: string;
  actionInstruction?: string;
  changedCondition?: string;
  constants?: string[];
  /** Gated: the adult re-checks the card. */
  factStatement?: string;
  questionPrompt?: string;
  key?: Partial<Pick<Card['key'], 'expectedCause' | 'acceptable' | 'typicalMistake' | 'followUp'>>;
}

export interface RevisionResult {
  cardId: string;
  reapproval: boolean;
  changed: string[];
}

export function reviseCard(card: Card, patch: CardPatch, opts: { at?: Date; who?: string; why?: string } = {}): RevisionResult {
  const at = (opts.at ?? new Date()).toISOString();
  const free: string[] = [];
  const gated: string[] = [];
  const set = <T>(label: string, before: T, after: T | undefined, apply: (v: T) => void, bucket: string[]) => {
    if (after === undefined || JSON.stringify(after) === JSON.stringify(before)) return;
    bucket.push(`${label} (было: ${Array.isArray(before) ? before.join('; ') : String(before)})`);
    apply(after);
  };
  set('hook', card.hook.question, patch.hookQuestion, (v) => (card.hook.question = v), free);
  set('predict', card.hook.predictPrompt, patch.predictPrompt, (v) => (card.hook.predictPrompt = v), free);
  set('explanation', card.explanation, patch.explanation, (v) => (card.explanation = v), free);
  set('act', card.action.instruction, patch.actionInstruction, (v) => (card.action.instruction = v), free);
  set('changedCondition', card.action.changedCondition, patch.changedCondition, (v) => (card.action.changedCondition = v), free);
  set('constants', card.action.constants, patch.constants, (v) => (card.action.constants = v), free);
  set('fact', card.fact.statement, patch.factStatement, (v) => (card.fact.statement = v), gated);
  set('question/transfer', card.question.prompt, patch.questionPrompt, (v) => (card.question.prompt = v), gated);
  for (const k of ['expectedCause', 'acceptable', 'typicalMistake', 'followUp'] as const) {
    set(`key.${k}`, card.key[k] as never, patch.key?.[k] as never, (v) => ((card.key as Record<string, unknown>)[k] = v), gated);
  }
  const why = opts.why ? ` — ${opts.why}` : '';
  if (free.length) markRevised(card, `${free.join('; ')}${why}`, { at: opts.at });
  if (gated.length) {
    card.review = {
      state: 'needs_review',
      reviewer: null,
      reviewedAt: null,
      notes: [...card.review.notes, `${at} на переодобрение (${opts.who ?? 'course module'}): ${gated.join('; ')}${why}`],
    };
  }
  return { cardId: card.id, reapproval: gated.length > 0, changed: [...free, ...gated].map((s) => s.split(' (')[0]!) };
}

/** Course-level review follows the cards: any card back in review → the course needs review. */
export function syncCourseReview(course: Course): void {
  const cards = course.concepts.flatMap((k) => k.cards);
  if (cards.some((c) => c.review.state === 'draft' || c.review.state === 'needs_review')) {
    course.review = { ...course.review, state: 'needs_review' };
  }
}
