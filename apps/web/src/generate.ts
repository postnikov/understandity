import type { Course } from '@understandity/contracts';
import { ApiFailure } from './api.js';

/**
 * Course on request (contract «курс по запросу», HQ 24.10 14:58):
 *   POST /api/courses/generate {request, audience, lang, engine} → 202 {jobId} | 409 {code: "online_unavailable"}
 *   GET  /api/courses/generate/:jobId → {status, step?, courseId?, error?}
 * The finished course appears in /api/courses with origin.generator = "on-request" and is shown right away
 * (as a draft) with the mark «AI-generated · not checked by an adult».
 * Until the server route exists (branch mod/gen) a route-level 404 switches to a mock with the same shapes.
 */
export type Audience = 'child' | 'adult';
export type GenEngine = 'local' | 'online';
export type GenStep = 'outline' | 'cards' | 'worlds' | 'saving';
export interface GenRequest {
  request: string;
  audience: Audience;
  lang: 'en';
  engine: GenEngine;
}
export interface GenJob {
  status: 'queued' | 'running' | 'done' | 'failed';
  step?: GenStep | string;
  courseId?: string;
  error?: { code: string; message: string };
}

export const isOnRequest = (c: Pick<Course, 'origin'> | null | undefined) => (c?.origin as { generator?: string } | undefined)?.generator === 'on-request';
export const originOf = (c: Pick<Course, 'origin'>) => c.origin as Course['origin'] & { request?: string; engine?: GenEngine; model?: string | null };

/* ------------------------------------------------------------------ */
/* mock — same shapes, clearly temporary                              */
/* ------------------------------------------------------------------ */

const STORE = 'understandity.mock.generated';
const MOCK_PREFIX = 'mock-gen-';
let mockMode = false;
export const isGenMock = () => mockMode;
export const isMockCourseId = (id: string) => id.startsWith(MOCK_PREFIX);

interface MockJob {
  body: GenRequest;
  startedAt: number;
  courseId: string;
}
const jobs = new Map<string, MockJob>();

export function mockGenerated(): Course[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as Course[];
  } catch {
    return [];
  }
}
function saveMock(courses: Course[]) {
  sessionStorage.setItem(STORE, JSON.stringify(courses));
}
export const mockGeneratedCourse = (id: string) => mockGenerated().find((c) => c.id === id) ?? null;

/** Step timings of the mock (seconds): long enough to see every progress state, short enough to demo. */
const MOCK_PLAN: Array<[GenStep, number]> = [
  ['outline', 2],
  ['cards', 3.5],
  ['worlds', 2],
  ['saving', 0.8],
];

async function mockStart(body: GenRequest): Promise<{ jobId: string }> {
  if (body.engine === 'online') {
    const keys = (await fetch('/api/keys').then((r) => (r.ok ? r.json() : [])).catch(() => [])) as Array<{ id: string; set: boolean }>;
    if (!keys.some((k) => k.id === 'anthropic' && k.set)) throw new ApiFailure('online_unavailable', 'Online generation needs an Anthropic key', 409);
  }
  const jobId = `mockjob-${Date.now().toString(36)}`;
  jobs.set(jobId, { body, startedAt: performance.now(), courseId: `${MOCK_PREFIX}${Date.now().toString(36)}` });
  return { jobId };
}

async function mockStatus(jobId: string): Promise<GenJob> {
  const job = jobs.get(jobId);
  if (!job) return { status: 'failed', error: { code: 'not_found', message: 'This job is gone (page was reloaded).' } };
  let t = (performance.now() - job.startedAt) / 1000;
  if (job.body.engine === 'online') t *= 2; // online is faster
  for (const [step, sec] of MOCK_PLAN) {
    if (t < sec) return { status: 'running', step };
    t -= sec;
  }
  if (!mockGeneratedCourse(job.courseId)) await buildMockCourse(job);
  return { status: 'done', step: 'saving', courseId: job.courseId };
}

/** Mock content: an existing English course re-labelled with the request. Real content comes from mod/gen. */
async function buildMockCourse(job: MockJob) {
  const list = (await fetch('/api/courses').then((r) => r.json())) as Array<{ id: string; lang?: string; language?: string }>;
  const base = list.find((c) => (c.lang ?? c.language ?? 'en').startsWith('en'));
  if (!base) throw new ApiFailure('internal', 'mock: no course to copy');
  const src = (await fetch(`/api/courses/${encodeURIComponent(base.id)}`).then((r) => r.json())) as Course;
  const req = job.body.request.trim();
  const course: Course = structuredClone(src);
  course.id = job.courseId;
  course.title = req.charAt(0).toUpperCase() + req.slice(1).replace(/[.?!]*$/, '?');
  course.outcome = `Mock course for «${req}» — real cards come from the generator (mod/gen).`;
  course.review = { state: 'needs_review', reviewer: null, reviewedAt: null, notes: [] };
  for (const k of course.concepts) for (const card of k.cards) card.review = { state: 'needs_review', reviewer: null, reviewedAt: null, notes: [] };
  (course as unknown as { origin: Record<string, unknown> }).origin = {
    generator: 'on-request',
    request: req,
    engine: job.body.engine,
    audience: job.body.audience,
    model: job.body.engine === 'online' ? 'claude-sonnet-5-5 (mock)' : 'gemma (mock)',
    createdAt: new Date().toISOString(),
  };
  saveMock([...mockGenerated(), course]);
}

/* ------------------------------------------------------------------ */
/* api                                                                */
/* ------------------------------------------------------------------ */

export async function startGeneration(body: GenRequest): Promise<{ jobId: string }> {
  if (mockMode) return mockStart(body);
  const res = await fetch('/api/courses/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = (await res.json().catch(() => null)) as { jobId?: string; code?: string; error?: { code: string; message: string } } | null;
  if (res.status === 404 && !payload?.error && !payload?.code) {
    mockMode = true;
    return mockStart(body);
  }
  if (!res.ok || !payload?.jobId) {
    const code = payload?.code ?? payload?.error?.code ?? 'internal';
    throw new ApiFailure(code, payload?.error?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return { jobId: payload.jobId };
}

export async function generationStatus(jobId: string): Promise<GenJob> {
  if (mockMode || jobId.startsWith('mockjob-')) return mockStatus(jobId);
  const res = await fetch(`/api/courses/generate/${encodeURIComponent(jobId)}`);
  const payload = (await res.json().catch(() => null)) as GenJob | { error: { code: string; message: string } } | null;
  if (!res.ok || !payload || !('status' in payload)) {
    const err = payload && 'error' in payload ? payload.error : { code: 'unavailable', message: `${res.status} ${res.statusText}` };
    return { status: 'failed', error: err };
  }
  return payload;
}
