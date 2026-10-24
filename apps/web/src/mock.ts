import type { Card, Course } from '@understandity/contracts';
import { summarize, type CourseSummary, type ReviewRequest } from './api.js';

/**
 * Stand-in for the «Курс» module's courses API until the branches merge.
 * Source of truth for content is the existing `/api/course`; review decisions are kept in
 * sessionStorage of this tab only, so nothing pretends to be persisted on the server.
 */
const KEY = 'understandity.mock.reviews';
type Saved = Record<string, { state: 'approved' | 'blocked'; edits?: ReviewRequest['edits']; at: string }>;

const load = (): Saved => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
};

let base: Course | null = null;
async function source(): Promise<Course> {
  if (!base) {
    const r = await fetch('/api/course');
    if (!r.ok) throw new Error(`/api/course ${r.status}`);
    base = (await r.json()) as Course;
  }
  return base;
}

function apply(course: Course): Course {
  const saved = load();
  const copy = structuredClone(course);
  for (const concept of copy.concepts) {
    concept.cards = concept.cards.map((card): Card => {
      const s = saved[`${copy.id}/${card.id}`];
      if (!s) return card;
      const e = s.edits ?? {};
      return {
        ...card,
        fact: e.fact ? { ...card.fact, ...e.fact } : card.fact,
        question: e.question ? { ...card.question, ...e.question } : card.question,
        key: e.key ? { ...card.key, ...e.key } : card.key,
        review: { ...card.review, state: s.state, reviewer: 'adult (mock)', reviewedAt: s.at },
      };
    });
  }
  return copy;
}

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));

export const mockCourses = {
  async list(): Promise<CourseSummary[]> {
    return delay([summarize(apply(await source()))]);
  },
  async get(id: string): Promise<Course> {
    const c = apply(await source());
    if (c.id !== id) throw new Error(`mock: unknown course ${id}`);
    return delay(c);
  },
  async review(id: string, req: ReviewRequest): Promise<Course> {
    const saved = load();
    saved[`${id}/${req.cardId}`] = { state: req.status, edits: req.edits, at: new Date().toISOString() };
    sessionStorage.setItem(KEY, JSON.stringify(saved));
    return mockCourses.get(id);
  },
};
