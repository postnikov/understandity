import { z } from 'zod';
import { CourseSchema, findCard, isShowable, showsDrafts, type Course } from '@understandity/contracts';

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
  /** Who made the course; `generator: 'on-request'` = a learner's request, shown without an adult (UI marks it). */
  origin: Course['origin'];
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
    origin: course.origin,
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

/**
 * What a child may see, concepts without cards dropped: approved cards only — except a course made on the
 * learner's own request, which is shown at once (not blocked cards) and marked as not checked (`origin`).
 */
export function showableCourse(course: Course): Course {
  const allowDrafts = showsDrafts(course);
  return {
    ...course,
    concepts: course.concepts
      .map((k) => ({ ...k, cards: k.cards.filter((c) => isShowable(c, { allowDrafts })) }))
      .filter((k) => k.cards.length > 0),
  };
}
