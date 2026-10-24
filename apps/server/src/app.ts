import { resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { ZodError } from 'zod';
import {
  EngineError,
  ImageRequestSchema,
  TtsHttpRequestSchema,
  isShowable,
  type Course,
  type EngineErrorCode,
  type EnginesResponse,
} from '@understandity/contracts';
import type { EngineHub } from './engines.js';
import type { KeyStore } from './keys.js';
import { tutorTurn, type CourseLookup } from './tutor.js';
import { courseRoutes, defaultContentDir, scanCourses } from './routes/course.js';

const STATUS: Record<EngineErrorCode, 400 | 403 | 409 | 422 | 424 | 499 | 500 | 501 | 503 | 504> = {
  bad_input: 400,
  offline_forbidden: 403,
  busy: 409,
  no_speech: 422,
  unsupported: 422,
  model_missing: 424,
  cancelled: 499,
  internal: 500,
  not_implemented: 501,
  unavailable: 503,
  timeout: 504,
};

/** 30 s of browser audio is far below this; protects the local machine from accidental huge uploads. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface AppDeps {
  hub: EngineHub;
  course: Course;
  /** Show and tutor `needs_review` cards. Off by default: the adult gate is part of the product. */
  allowDrafts: boolean;
  /** Folder with course JSON files and `media/` (pre-rendered scene images). */
  contentDir?: string;
  /** API keys entered in Settings; values never leave the server. */
  keys?: KeyStore;
}

export function createApp({ hub, course, allowDrafts, contentDir = defaultContentDir(), keys }: AppDeps) {
  const root = new Hono();
  const app = new Hono();
  const lookup: CourseLookup = async (id) => (await scanCourses(contentDir)).get(id)?.course ?? (id === course.id ? course : null);

  app.onError((err, c) => {
    if (EngineError.is(err)) return c.json({ error: err.toPayload() }, STATUS[err.code] as 400);
    if (err instanceof ZodError) {
      const e = new EngineError('bad_input', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      return c.json({ error: e.toPayload() }, 400);
    }
    console.error(err);
    return c.json({ error: new EngineError('internal', err instanceof Error ? err.message : String(err)).toPayload() }, 500);
  });

  app.get('/health', async (c) => {
    const providers = await hub.summaries();
    const active = providers.filter((p) => hub.getSettings().engines[p.modality].provider === p.provider);
    const ok = active.every((p) => p.health?.state === 'ok');
    return c.json({ ok, profile: hub.getSettings().profile, active });
  });

  app.get('/engines', async (c) => {
    const body: EnginesResponse = { settings: hub.getSettings(), providers: await hub.summaries(), dispatcher: hub.dispatcher.status() };
    return c.json(body);
  });

  app.get('/settings', (c) => c.json(hub.getSettings()));

  // API keys: status only (set / not set, env or file) — a value is accepted, never returned.
  app.get('/keys', (c) => c.json(keys?.status() ?? []));
  app.put('/keys/:id', async (c) => {
    if (!keys) throw new EngineError('unsupported', 'key storage is not enabled');
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    return c.json(keys.set(c.req.param('id'), body.value));
  });
  app.delete('/keys/:id', (c) => {
    if (!keys) throw new EngineError('unsupported', 'key storage is not enabled');
    const status = keys.clear(c.req.param('id'));
    // Losing the last key while Online would leave the app pointing at the cloud: fall back to the Offline defaults.
    if (hub.getSettings().profile === 'online' && !hub.anyKey()) hub.resetToDefaults();
    return c.json(status);
  });

  app.put('/settings', async (c) => {
    const res = hub.updateSettings(await c.req.json());
    return c.json(res, res.ok ? 200 : 422);
  });

  app.get('/course', (c) => {
    const visible = {
      ...course,
      concepts: course.concepts.map((k) => ({ ...k, cards: k.cards.filter((card) => isShowable(card, { allowDrafts })) })),
    };
    return c.json(visible);
  });

  app.post('/stt', async (c) => {
    const mimeType = c.req.header('content-type')?.split(';')[0] ?? 'application/octet-stream';
    if (!mimeType.startsWith('audio/')) throw new EngineError('bad_input', `expected audio/* body, got ${mimeType}`, { modality: 'stt' });
    const audio = new Uint8Array(await c.req.arrayBuffer());
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new EngineError('bad_input', 'recording too large', { modality: 'stt' });
    const language = c.req.query('lang') ?? hub.getSettings().language;
    const transcript = await hub.run('stt', 'transcribe', (stt, model, signal) =>
      stt.transcribe({ model, audio, mimeType, language, prompt: c.req.query('prompt') }, { signal }),
    );
    return c.json(transcript);
  });

  app.route('/courses', courseRoutes({ contentDir }));

  app.post('/tutor', async (c) => c.json(await tutorTurn(hub, lookup, await c.req.json(), { allowDrafts })));

  /** SSE: `delta` {text} while the engine streams, then one `done` TutorTurnReply, or one `error` {error}. */
  app.post('/tutor/stream', async (c) => {
    const body = await c.req.json();
    return streamSSE(c, async (sse) => {
      const ctrl = new AbortController();
      sse.onAbort(() => ctrl.abort());
      let chain = Promise.resolve();
      try {
        const reply = await tutorTurn(hub, lookup, body, {
          allowDrafts,
          signal: ctrl.signal,
          onDelta: (text) => {
            chain = chain.then(() => sse.writeSSE({ event: 'delta', data: JSON.stringify({ text }) }));
          },
        });
        await chain;
        await sse.writeSSE({ event: 'done', data: JSON.stringify(reply) });
      } catch (err) {
        await chain.catch(() => undefined);
        const e = EngineError.is(err) ? err : new EngineError('internal', err instanceof Error ? err.message : String(err));
        await sse.writeSSE({ event: 'error', data: JSON.stringify({ error: e.toPayload() }) });
      }
    });
  });

  app.post('/tts', async (c) => {
    const body = TtsHttpRequestSchema.parse(await c.req.json());
    const { voice } = hub.get('tts');
    const result = await hub.run('tts', 'speak', (tts, model, signal) =>
      tts.synthesize({ model, text: body.text, language: body.language ?? hub.getSettings().language, voice: voice ?? undefined }, { signal }),
    );
    return c.body(result.audio as Uint8Array<ArrayBuffer>, 200, {
      'content-type': result.mimeType,
      'x-duration-sec': String(result.durationSec),
      'x-model': result.model,
    });
  });

  app.post('/image', async (c) => {
    const body = await c.req.json();
    const job = await hub.run('image', 'illustrate', (image, model, signal) =>
      image.generate(ImageRequestSchema.parse({ ...body, model }), { signal }),
    );
    return c.json(job);
  });

  app.get('/image/:jobId', async (c) => {
    const { adapter } = hub.get('image');
    return c.json(await adapter.getJob(c.req.param('jobId')));
  });

  root.route('/api', app);
  // Pre-rendered scene images from the course build step: `worlds[].image` = `/media/<course>/<card>-<world>.png`.
  root.use('/media/*', serveStatic({ root: resolve(contentDir) }));
  return root;
}
