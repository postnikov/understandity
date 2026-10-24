import { errorText, esc, rerender, t } from '../app.js';
import { api, ApiFailure } from '../api.js';
import { generationStatus, isGenMock, startGeneration, type Audience, type GenEngine, type GenRequest, type GenStep } from '../generate.js';

/**
 * «Make your own course» on the home screen: a request in plain words, who it is for, local or online model,
 * then honest progress by the server's `step`, and the finished course opens right away.
 */
type Phase = 'form' | 'running' | 'failed';

const m = {
  phase: 'form' as Phase,
  request: '',
  audience: 'child' as Audience,
  engine: 'local' as GenEngine,
  onlineReady: false,
  step: null as string | null,
  queued: false,
  startedAt: 0,
  error: null as { code: string; message: string } | null,
  last: null as GenRequest | null,
  token: 0,
};
let tick: ReturnType<typeof setInterval> | null = null;

/** Honest estimates: Gemma wrote a five-card draft in ~45 s on Studio (23.10); Sonnet is several times faster. */
const ESTIMATE_SEC: Record<GenEngine, number> = { local: 60, online: 20 };
const STEPS: GenStep[] = ['outline', 'cards', 'worlds', 'saving'];

export async function refreshKeys() {
  const keys = await api.keys().catch(() => []);
  m.onlineReady = keys.some((k) => k.id === 'anthropic' && k.set);
  if (!m.onlineReady && m.engine === 'online') m.engine = 'local';
}

function seg<T extends string>(name: string, value: T, current: T, label: string, hint: string, disabled = false, why = '') {
  return `<button type="button" class="seg ${value === current ? 'on' : ''}" data-${name}="${value}" aria-pressed="${value === current}" ${disabled ? `disabled title="${esc(why)}"` : ''}>
    <b>${label}</b><span>${disabled && why ? esc(why) : hint}</span></button>`;
}

function form(): string {
  const d = t().make;
  return `<form class="make-form" id="make-form">
    <label class="make-q"><span class="label">${d.question}</span>
      <input type="text" name="request" value="${esc(m.request)}" placeholder="${esc(d.placeholder)}" maxlength="200" autocomplete="off" required /></label>
    <div class="make-row">
      <div class="seg-group" role="group" aria-label="${esc(d.forWho)}">
        ${seg('audience', 'child', m.audience, d.child, d.childHint)}
        ${seg('audience', 'adult', m.audience, d.adult, d.adultHint)}
      </div>
      <div class="seg-group" role="group" aria-label="${esc(d.engine)}">
        ${seg('engine', 'local', m.engine, d.local, d.localHint)}
        ${seg('engine', 'online', m.engine, d.online, d.onlineHint, !m.onlineReady, d.onlineNoKey)}
      </div>
    </div>
    <div class="make-actions">
      <button class="btn btn--xl" type="submit">${d.go} <span aria-hidden="true">→</span></button>
      ${!m.onlineReady ? `<a class="text-btn text-btn--dim" href="#/engines">${d.addKey}</a>` : ''}
    </div>
  </form>`;
}

function progress(): string {
  const d = t().make;
  const est = ESTIMATE_SEC[m.engine];
  const elapsed = Math.round((performance.now() - m.startedAt) / 1000);
  const cur = m.step ? STEPS.indexOf(m.step as GenStep) : -1;
  return `<div class="make-progress" aria-live="polite">
    <p class="make-req">«${esc(m.request)}» <span class="dim">· ${m.audience === 'child' ? d.child : d.adult} · ${m.engine === 'local' ? d.local : d.online}</span></p>
    <ol class="make-steps">${STEPS.map((st, i) => `<li class="${i < cur ? 'done' : i === cur ? 'on' : ''}">${d.steps[st]}</li>`).join('')}</ol>
    <p class="make-time"><b id="make-elapsed">${elapsed}s</b> <span id="make-est">${elapsed > est * 2 ? d.slow : m.queued ? d.queued : d.estimate[m.engine]}</span></p>
  </div>`;
}

function failure(): string {
  const d = t().make;
  const e = m.error!;
  const text = d.errors[e.code] ?? `${d.errors.default} ${e.message}`;
  return `<div class="make-fail"><p class="alert alert--err"><b>××</b><span>${esc(text)}</span></p>
    <div class="make-actions"><button class="btn" id="make-retry">${d.retry}</button><button class="btn btn--ghost" id="make-edit">${d.edit}</button>
    ${e.code === 'online_unavailable' ? `<a class="text-btn" href="#/engines">${d.addKey}</a>` : ''}</div></div>`;
}

export function makePanel(): string {
  const d = t().make;
  return `<section class="make" id="make">
    <div class="make-head"><div><div class="eyebrow">${d.kicker}</div><h2>${d.title}</h2></div><p class="dim">${d.lead}</p></div>
    ${m.phase === 'running' ? progress() : m.phase === 'failed' ? failure() : form()}
    ${isGenMock() ? `<p class="faint" style="font-size:11px;margin-top:var(--s-3)">${d.mock}</p>` : ''}
  </section>`;
}

function stopTick() {
  if (tick) clearInterval(tick);
  tick = null;
}

async function run(body: GenRequest) {
  const token = ++m.token;
  m.last = body;
  m.phase = 'running';
  m.step = null;
  m.queued = true;
  m.error = null;
  m.startedAt = performance.now();
  rerender();
  stopTick();
  tick = setInterval(() => {
    const el = document.getElementById('make-elapsed');
    if (el) el.textContent = `${Math.round((performance.now() - m.startedAt) / 1000)}s`;
  }, 1000);
  const fail = (code: string, message: string) => {
    if (token !== m.token) return;
    stopTick();
    m.phase = 'failed';
    m.error = { code, message };
    rerender();
  };
  try {
    const { jobId } = await startGeneration(body);
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      if (token !== m.token) return;
      const job = await generationStatus(jobId);
      if (job.status === 'failed') return fail(job.error?.code ?? 'internal', job.error?.message ?? '');
      if (job.status === 'done' && job.courseId) {
        stopTick();
        m.phase = 'form';
        m.request = '';
        location.hash = `#/learn/${encodeURIComponent(job.courseId)}`;
        return;
      }
      const changed = job.step !== m.step || m.queued !== (job.status === 'queued');
      m.step = job.step ?? null;
      m.queued = job.status === 'queued';
      if (changed) rerender();
    }
  } catch (err) {
    fail(err instanceof ApiFailure ? err.code : 'internal', errorText(err));
  }
}

export function bindMake(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-audience]').forEach((b) =>
    b.addEventListener('click', () => {
      m.audience = b.dataset.audience as Audience;
      m.request = (root.querySelector<HTMLInputElement>('#make-form input[name=request]')?.value ?? m.request).trim();
      rerender();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>('[data-engine]').forEach((b) =>
    b.addEventListener('click', () => {
      m.engine = b.dataset.engine as GenEngine;
      m.request = (root.querySelector<HTMLInputElement>('#make-form input[name=request]')?.value ?? m.request).trim();
      rerender();
    }),
  );
  root.querySelector<HTMLFormElement>('#make-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const request = new FormData(e.target as HTMLFormElement).get('request')?.toString().trim() ?? '';
    if (!request) return;
    m.request = request;
    void run({ request, audience: m.audience, lang: 'en', engine: m.engine });
  });
  root.querySelector('#make-retry')?.addEventListener('click', () => m.last && void run(m.last));
  root.querySelector('#make-edit')?.addEventListener('click', () => {
    // Re-read the keys: without an Anthropic key the choice falls back to Local, so the next run can't hit 409 again.
    void refreshKeys().then(() => {
      m.phase = 'form';
      rerender();
    });
  });
}

/** Leaving the home screen keeps the job running in the background; only the timer stops redrawing. */
export function leaveMake() {
  if (m.phase !== 'running') stopTick();
}
