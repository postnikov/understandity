import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { EngineError, LanguageSchema, type Course } from '@understandity/contracts';
import { generateCourse, slugify, type GenerationStep } from '@understandity/course';
import type { EngineHub } from '../engines.js';
import { scanCourses } from './course.js';

/**
 * Course on request: a learner names what they do not understand,
 * the model writes a five-card course from its own knowledge, the course is saved to `content/<slug>.json`
 * and shown at once, marked as not checked by an adult.
 *   POST /api/courses/generate         {request, audience, lang, engine} → 202 {jobId} | 409 {code: "online_unavailable"}
 *   GET  /api/courses/generate/:jobId  → {status, step?, courseId?, error?}
 * Jobs live in memory, one generation at a time; local engines also go through the heavy-task dispatcher.
 */

/** Contract: online = the anthropic provider; its course model comes from `options.courseModel` in engines.json. */
const ONLINE_PROVIDER = 'anthropic';
/** Honest source line on every card: nobody verified these facts. */
export const MODEL_KNOWLEDGE_SOURCE = 'Generated from model knowledge, not checked';
const MAX_JOBS = 100;

export const GenerateRequestSchema = z.object({
  request: z.string().trim().min(3).max(500),
  audience: z.enum(['child', 'adult']).default('child'),
  lang: LanguageSchema.default('en'),
  engine: z.enum(['local', 'online']).default('local'),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export interface GenerateJob {
  status: 'queued' | 'running' | 'done' | 'failed';
  step?: GenerationStep;
  courseId?: string;
  error?: { code: string; message: string };
}

export interface GenerateRoutesOptions {
  hub: EngineHub;
  contentDir: string;
  /** Worlds and card count of an on-request course (Max's brief: five cards, fantasy and anime). */
  worlds?: string[];
  cardCount?: number;
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export function generateRoutes({ hub, contentDir, worlds = ['fantasy', 'anime'], cardCount = 5 }: GenerateRoutesOptions) {
  const app = new Hono();
  const jobs = new Map<string, GenerateJob>();
  let queue: Promise<unknown> = Promise.resolve();

  /** Local: the active text engine when it is local (the one the tutor already holds), else the config default. */
  function pickEngine(engine: GenerateRequest['engine']) {
    if (engine === 'online') {
      const hit = hub.textEngine(ONLINE_PROVIDER);
      if (!hit) return null;
      return { ...hit, model: (hit.config.options.courseModel as string | undefined) ?? hit.config.models[0]! };
    }
    const sel = hub.getSettings().engines.text;
    const { provider, model } = hub.config.providers.text[sel.provider]?.locality === 'local' ? sel : hub.config.defaults.engines.text;
    const hit = hub.textEngine(provider);
    if (!hit) throw new EngineError('unavailable', `text provider "${provider}" is not available`, { modality: 'text', provider });
    return { ...hit, model };
  }

  const onlineUnavailable = () =>
    new EngineError('unavailable', 'online generation needs an Anthropic key (Engines → API keys)', { modality: 'text', provider: ONLINE_PROVIDER });

  async function run(job: GenerateJob, body: GenerateRequest) {
    job.status = 'running';
    job.step = 'outline';
    const picked = pickEngine(body.engine);
    if (!picked) throw onlineUnavailable();
    const opt = picked.config.options;
    const { course } = await generateCourse(
      {
        topic: body.request,
        request: body.request,
        audience: body.audience,
        language: body.lang,
        ageRange: body.audience === 'adult' ? [18, 99] : [12, 14],
        worlds,
        cardCount,
        source: { label: MODEL_KNOWLEDGE_SOURCE, url: null },
        origin: { generator: 'on-request', request: body.request, engine: body.engine },
      },
      {
        text: picked.adapter,
        model: picked.model,
        dispatcher: hub.dispatcher,
        maxTokens: num(opt.courseNumPredict) ?? num(opt.courseMaxTokens),
        timeoutMs: num(opt.courseTimeoutMs),
        onStep: (step) => (job.step = step),
      },
    );
    job.step = 'saving';
    job.courseId = await save(course);
    job.status = 'done';
  }

  /** `content/<slug>.json`; a title already taken gets `-2`, `-3`… — a request never overwrites a course. */
  async function save(course: Course): Promise<string> {
    await mkdir(contentDir, { recursive: true });
    const taken = new Set((await scanCourses(contentDir)).keys());
    const base = slugify(course.title) || 'course';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const path = join(contentDir, `${id}.json`);
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify({ ...course, id }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, path);
    return id;
  }

  app.post('/', async (c) => {
    const body = GenerateRequestSchema.parse(await c.req.json());
    if (body.engine === 'online' && !hub.textEngine(ONLINE_PROVIDER)) {
      return c.json({ code: 'online_unavailable', message: onlineUnavailable().message }, 409);
    }
    const jobId = randomUUID();
    const job: GenerateJob = { status: 'queued' };
    jobs.set(jobId, job);
    for (const [id, j] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (j.status === 'done' || j.status === 'failed') jobs.delete(id);
    }
    queue = queue
      .then(() => run(job, body))
      .catch((err: unknown) => {
        job.status = 'failed';
        const e = EngineError.is(err) ? err : new EngineError('internal', err instanceof Error ? err.message : String(err));
        const code = body.engine === 'online' && e.code === 'unavailable' && e.provider === ONLINE_PROVIDER ? 'online_unavailable' : e.code;
        job.error = { code, message: e.message };
      });
    return c.json({ jobId }, 202);
  });

  app.get('/:jobId', (c) => {
    const job = jobs.get(c.req.param('jobId'));
    if (!job) return c.json({ error: { code: 'not_found', message: 'no such generation job' } }, 404);
    return c.json(job);
  });

  return app;
}
