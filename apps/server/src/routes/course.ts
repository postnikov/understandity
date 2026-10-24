import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { CourseSchema, EngineError, type Course } from '@understandity/contracts';
import { ReviewRequestSchema, applyReview, courseSummary, showableCourse } from '@understandity/course';
import { REPO_ROOT } from '../config.js';

/**
 * Courses and the adult review gate. Files: `content/*.json` (any name; the course `id` inside is the key).
 *   GET  /api/courses                 → [{id, title, lang, pendingReview, ...}]
 *   GET  /api/courses/:id             → full course for the adult (every card, every review state)
 *   GET  /api/courses/:id/showable    → what a child may see: approved cards only (`isShowable`, no drafts)
 *   POST /api/courses/:id/review      → {cardId, status: approved|blocked, edits?: {fact?, question?, key?}, reviewer?, note?}
 */
export interface CourseRoutesOptions {
  contentDir?: string;
}

export function courseRoutes(opts: CourseRoutesOptions = {}) {
  const dir = opts.contentDir ?? process.env.UNDERSTANDITY_CONTENT_DIR ?? resolve(REPO_ROOT, 'content');
  const app = new Hono();
  let writeChain: Promise<unknown> = Promise.resolve();

  async function scan(): Promise<Map<string, { path: string; course: Course }>> {
    const out = new Map<string, { path: string; course: Course }>();
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const path = join(dir, f);
      try {
        const parsed = CourseSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (parsed.success && !out.has(parsed.data.id)) out.set(parsed.data.id, { path, course: parsed.data });
      } catch {
        /* not a course file */
      }
    }
    return out;
  }

  async function load(id: string) {
    const hit = (await scan()).get(id);
    if (!hit) throw new EngineError('bad_input', `course "${id}" not found`);
    return hit;
  }

  app.get('/', async (c) => c.json([...(await scan()).values()].map(({ course }) => courseSummary(course))));

  app.get('/:id', async (c) => c.json((await load(c.req.param('id'))).course));

  app.get('/:id/showable', async (c) => c.json(showableCourse((await load(c.req.param('id'))).course)));

  app.post('/:id/review', async (c) => {
    const body = ReviewRequestSchema.parse(await c.req.json());
    const id = c.req.param('id');
    const job = writeChain.then(async () => {
      const { path, course } = await load(id);
      let next: Course;
      try {
        next = applyReview(course, body);
      } catch (e) {
        if (e instanceof Error && e.message === 'card_not_found') throw new EngineError('bad_input', `card "${body.cardId}" not found in "${id}"`);
        throw e;
      }
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, path);
      return next;
    });
    writeChain = job.catch(() => undefined);
    const next = await job;
    const card = next.concepts.flatMap((k) => k.cards).find((k) => k.id === body.cardId);
    return c.json({ ok: true, card, course: courseSummary(next) });
  });

  return app;
}
