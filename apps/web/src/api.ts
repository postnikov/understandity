import type {
  Card,
  Course,
  EnginesResponse,
  ImageJob,
  ReviewState,
  Settings,
  SettingsIssue,
  Transcript,
  TutorTurnReply,
  TutorTurnRequest,
} from '@understandity/contracts';
import { isLangEnabled } from './app.js';
import { mockCourses } from './mock.js';
import { isMockCourseId, mockGenerated, mockGeneratedCourse } from './generate.js';

export interface KeyStatus {
  id: string;
  label: string;
  env: string;
  set: boolean;
  source: 'env' | 'file' | null;
}

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) throw new ApiFailure('unavailable', `${res.status} ${res.statusText}`, res.status);
  }
  const err = (body as { error?: { code: string; message: string } } | null)?.error;
  if (!res.ok) throw new ApiFailure(err?.code ?? 'internal', err?.message ?? `${res.status} ${res.statusText}`, res.status);
  return body as T;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/* ------------------------------------------------------------------ */
/* Courses API — owned by the «Курс» module. Shapes the web expects:   */
/*   GET  /api/courses             → CourseSummary[] | {courses: …}    */
/*   GET  /api/courses/:id         → Course (all cards, incl. blocked) */
/*   POST /api/courses/:id/review  ← ReviewRequest → Course | Card     */
/* Until the branches merge the server answers 404 and we use the mock */
/* in ./mock.ts with the same shapes; the UI shows a «Mock API» chip.  */
/* ------------------------------------------------------------------ */

export interface CourseSummary {
  id: string;
  title: string;
  outcome: string;
  subject: string;
  language: string;
  ageRange: [number, number];
  review: { state: ReviewState };
  /** Card counts by review state; computed from the course if the server leaves it out. */
  cards?: Partial<Record<ReviewState, number>> & { total?: number };
  concepts?: number;
}

export type ReviewStatusChoice = 'approved' | 'blocked';
export interface ReviewEdits {
  fact?: { statement: string };
  question?: { prompt: string };
  key?: { expectedCause: string };
}
export interface ReviewRequest {
  cardId: string;
  status: ReviewStatusChoice;
  edits?: ReviewEdits;
}

let mockMode: boolean | null = null;
export const isMock = () => mockMode === true;

export function summarize(course: Course): CourseSummary {
  const all = course.concepts.flatMap((c) => c.cards);
  const counts: Partial<Record<ReviewState, number>> & { total: number } = { total: all.length };
  for (const card of all) counts[card.review.state] = (counts[card.review.state] ?? 0) + 1;
  return {
    id: course.id,
    title: course.title,
    outcome: course.outcome,
    subject: course.subject,
    language: course.language,
    ageRange: course.ageRange,
    review: { state: course.review.state },
    cards: counts,
    concepts: course.concepts.length,
  };
}

async function realOrMock<T>(real: () => Promise<Response>, mock: () => Promise<T>): Promise<T> {
  if (mockMode) return mock();
  const res = await real();
  if (res.status === 404 && mockMode !== false) {
    const body = await res.clone().json().catch(() => null);
    // A route-level 404 from Hono has no `error` payload; a real "course not found" does.
    if (!body?.error) {
      mockMode = true;
      return mock();
    }
  }
  mockMode = false;
  return json<T>(res);
}

export const api = {
  /**
   * The server's list is `{id, title, lang, cards: number, …}` (module «Курс»); the web summary needs outcome,
   * age and per-state counts, so each entry is summarised from its full course. Local and three courses — cheap.
   */
  courses: async (): Promise<CourseSummary[]> => {
    const list = await realOrMock<Array<{ id: string }> | { courses: Array<{ id: string }> }>(
      () => fetch('/api/courses'),
      () => mockCourses.list(),
    );
    const items = Array.isArray(list) ? list : list.courses;
    // Only courses in an enabled language are offered (UI_LANGS): student choice and the adult gate alike.
    if (isMock()) return (items as CourseSummary[]).filter((c) => isLangEnabled(c.language));
    const full = await Promise.all(items.map((c) => api.course(c.id)));
    // Courses made on request by the generator mock (until mod/gen lands) live in this tab only.
    return [...full, ...mockGenerated()].filter((c) => isLangEnabled(c.language)).map(summarize);
  },
  course: (id: string): Promise<Course> =>
    isMockCourseId(id)
      ? Promise.resolve(mockGeneratedCourse(id)).then((c) => c ?? Promise.reject(new ApiFailure('not_found', 'This mock course lived in another tab.', 404)))
      : realOrMock(
      () => fetch(`/api/courses/${encodeURIComponent(id)}`),
      () => mockCourses.get(id),
    ),
  /** Server takes plain strings in `edits` and answers `{ok, card, course: summary}` — returned as the Card. */
  review: (courseId: string, req: ReviewRequest) =>
    realOrMock<Course | Card | { card: Card }>(
      () =>
        post(`/api/courses/${encodeURIComponent(courseId)}/review`, {
          cardId: req.cardId,
          status: req.status,
          ...(req.edits
            ? {
                edits: {
                  ...(req.edits.fact ? { fact: req.edits.fact.statement } : {}),
                  ...(req.edits.question ? { question: req.edits.question.prompt } : {}),
                  ...(req.edits.key ? { key: req.edits.key.expectedCause } : {}),
                },
              }
            : {}),
        }),
      () => mockCourses.review(courseId, req),
    ).then((r) => ('card' in r && !('concepts' in r) ? r.card : (r as Course | Card))),

  engines: () => fetch('/api/engines').then((r) => json<EnginesResponse>(r)),
  /** API keys: the server answers only set / not set and the source; a value is sent once and never comes back. */
  keys: () => fetch('/api/keys').then((r) => json<KeyStatus[]>(r)),
  setKey: (id: string, value: string) =>
    fetch(`/api/keys/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).then((r) =>
      json<KeyStatus[]>(r),
    ),
  clearKey: (id: string) => fetch(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<KeyStatus[]>(r)),
  saveSettings: (s: Settings) =>
    fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).then(async (r) => {
      const body = (await r.json()) as { ok: boolean; settings: Settings; issues: SettingsIssue[]; error?: { message: string } };
      if (body.error) throw new ApiFailure('bad_input', body.error.message, r.status);
      return body;
    }),
  transcribe: (audio: Blob, lang: string, prompt: string) =>
    fetch(`/api/stt?lang=${encodeURIComponent(lang)}&prompt=${encodeURIComponent(prompt)}`, {
      method: 'POST',
      headers: { 'content-type': audio.type || 'audio/webm' },
      body: audio,
    }).then((r) => json<Transcript>(r)),
  tutor: (req: TutorTurnRequest) => post('/api/tutor', req).then((r) => json<TutorTurnReply>(r)),
  /** SSE `POST /api/tutor/stream`: `delta` {text}… then `done` TutorTurnReply or `error` {error}. */
  tutorStream: async (req: TutorTurnRequest, onDelta: (text: string) => void): Promise<TutorTurnReply> => {
    const res = await post('/api/tutor/stream', req);
    if (!res.ok || !res.body) return json<TutorTurnReply>(res);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const event = /^event: ?(.*)$/m.exec(block)?.[1]?.trim() ?? 'message';
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        const payload = JSON.parse(data);
        if (event === 'delta') onDelta(payload.text);
        else if (event === 'done') return payload as TutorTurnReply;
        else if (event === 'error') throw new ApiFailure(payload.error?.code ?? 'internal', payload.error?.message ?? 'tutor failed');
      }
    }
    throw new ApiFailure('internal', 'tutor stream ended without an answer');
  },
  speak: async (text: string, language: string, turnId?: string): Promise<Blob> => {
    const r = await post(`/api/tts${turnId ? `?turn=${encodeURIComponent(turnId)}` : ''}`, { text, language });
    if (!r.ok) await json(r);
    return r.blob();
  },
  illustrate: (topic: string, style: string) => post('/api/image', { topic, style }).then((r) => json<ImageJob>(r)),
  imageJob: (jobId: string) => fetch(`/api/image/${encodeURIComponent(jobId)}`).then((r) => json<ImageJob>(r)),
};
