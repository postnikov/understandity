import {
  CYCLE_STEPS,
  VOICE_STEPS,
  isShowable,
  nextCycleStep,
  type Card,
  type Course,
  type CycleStep,
  type Evidence,
  type ImageJob,
  type TutorTurnReply,
} from '@understandity/contracts';
import { api, ApiFailure, isMock } from '../api.js';
import { app, errorText, esc, rerender, setWorld, t, worldLabel } from '../app.js';
import type { View } from '../main.js';
import { SILENCE_PEAK, VoiceRecorder } from '../recorder.js';

/**
 * Learning cycle of one card: hook → predict (voice) → explain → act (voice) → transfer (voice) → feedback.
 * Voice states are explicit: ready · listening · thinking · speaking, plus silence and error.
 * Silence is «no answer received» — never «did not understand».
 */
type VoiceState = 'idle' | 'listening' | 'transcribing' | 'confirm' | 'thinking' | 'speaking' | 'silence' | 'error';
interface Msg {
  role: 'student' | 'tutor';
  text: string;
  shown?: number;
  audio?: string;
  evidence?: Evidence | null;
  model?: string;
}

const s = {
  courseId: '',
  course: null as Course | null,
  cards: [] as Card[],
  index: 0,
  step: 'hook' as CycleStep,
  voice: 'idle' as VoiceState,
  heard: null as string | null,
  notice: null as string | null,
  error: null as string | null,
  loadError: null as string | null,
  dialog: [] as Msg[],
  hintsUsed: 0,
  answers: 0,
  evidence: null as Evidence | null,
  image: { state: 'none' as 'none' | 'wait' | 'done' | 'failed', src: null as string | null, token: 0 },
  allDone: false,
  listenStarted: 0,
  quiet: false,
};
type WorldScene = Card['worlds'][number];
const recorder = new VoiceRecorder();
let audio: HTMLAudioElement | null = null;
let raf = 0;
let streamTimer: ReturnType<typeof setInterval> | null = null;

const card = () => s.cards[s.index] ?? null;
const courseLang = () => s.course?.language ?? 'en';
const sceneOf = (c: Card): WorldScene => c.worlds.find((w) => w.world === app.world) ?? c.worlds[0]!;
const isVoiceStep = () => VOICE_STEPS.includes(s.step);

function voicePrompt(c: Card, step: CycleStep): string {
  if (step === 'predict') return c.hook.predictPrompt;
  if (step === 'act') return c.action.instruction;
  return c.question.prompt;
}

function safeImage(src: string | null): string | null {
  if (!src) return null;
  return /^(data:image\/|blob:|\/media\/)/.test(src) ? src : null;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function stepsBar(): string {
  const d = t();
  const cur = CYCLE_STEPS.indexOf(s.step);
  return `<ol class="steps" aria-label="steps">${CYCLE_STEPS.map((st, i) => {
    const cls = i === cur ? 'on' : i < cur ? 'past' : '';
    return `<li class="${cls}" ${i === cur ? 'aria-current="step"' : ''}><span class="n">${String(i + 1).padStart(2, '0')}</span>${d.steps[st]}</li>`;
  }).join('')}</ol>`;
}

function stepBody(c: Card): string {
  const d = t();
  const scene = sceneOf(c);
  switch (s.step) {
    case 'hook':
      return `<p class="hook">${esc(c.hook.question)}</p>
        <div class="scene"><span class="label">${d.scene} · ${esc(worldLabel(scene.world))}</span>${esc(scene.scene)}</div>`;
    case 'predict':
      return `<p class="prompt">${esc(c.hook.predictPrompt)}</p>`;
    case 'explain': {
      const img = safeImage(s.image.src);
      return `<p class="text">${esc(c.explanation)}</p>
        ${
          img
            ? `<img class="scheme" alt="${esc(scene.illustration)}" src="${esc(img)}">`
            : s.image.state === 'wait'
              ? `<div class="scheme-ph">${d.imageWait}</div>`
              : ''
        }`;
    }
    case 'act':
      return `<p class="prompt">${esc(c.action.instruction)}</p>
        <dl class="vars"><dt>${d.changed}</dt><dd>${esc(c.action.changedCondition)}</dd>
        ${c.action.constants.length ? `<dt>${d.same}</dt><dd>${esc(c.action.constants.join(' · '))}</dd>` : ''}</dl>`;
    case 'transfer':
      return `<p class="prompt">${esc(c.question.prompt)}</p>`;
    case 'feedback':
      return `<p class="text">${esc(s.answers ? d.wrap : d.wrapNone)}</p>${s.evidence ? `<div class="evidence" style="margin-top:var(--s-4)">${evidenceChips(s.evidence)}</div>` : ''}`;
  }
}

function evidenceChips(e: Evidence): string {
  const d = t().evidence;
  const causeCls = e.cause === 'correct' ? 'chip--ok' : e.cause === 'incorrect' ? 'chip--amber' : '';
  const trCls = e.transfer === 'independent' ? 'chip--ok' : e.transfer === 'with_hints' ? 'chip--accent' : '';
  return [
    e.prediction ? `<span class="chip">${d.prediction}: ${esc(e.prediction)}</span>` : '',
    `<span class="chip ${causeCls}">${esc(d.cause[e.cause] ?? e.cause)}</span>`,
    `<span class="chip ${trCls}">${esc(d.transfer[e.transfer] ?? e.transfer)}</span>`,
    `<span class="chip">${e.hintsUsed} ${d.hints}</span>`,
    e.quote ? `<span class="chip" title="quote">«${esc(e.quote)}»</span>` : '',
  ].join('');
}

const MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><rect x="9" y="3" width="6" height="11"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>`;
const STOP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/></svg>`;

function voiceBlock(): string {
  const d = t().voice;
  const v = s.voice;
  const busy = v === 'transcribing' || v === 'thinking' || v === 'speaking';
  const cls = v === 'confirm' ? 'speaking' : v === 'listening' ? 'listening' : v === 'transcribing' || v === 'thinking' ? 'thinking' : v === 'speaking' ? 'speaking' : v === 'error' || v === 'silence' ? 'error' : '';
  const title =
    v === 'confirm' ? d.check : v === 'listening' ? d.listening : v === 'transcribing' || v === 'thinking' ? d.thinking : v === 'speaking' ? d.speaking : v === 'silence' ? d.silence : v === 'error' ? d.error : d.idle;
  const hint =
    v === 'listening'
      ? s.quiet
        ? d.quiet
        : d.listeningHint
      : v === 'confirm'
        ? d.checkHint
      : v === 'transcribing'
        ? d.transcribing
        : v === 'thinking'
          ? d.tutorThinking
          : v === 'speaking'
            ? d.speakingHint
            : v === 'silence'
              ? d.silenceHint
              : v === 'error'
                ? (s.error ?? '')
                : d.idleHint;
  const max = card()?.question.maxAnswerSec ?? 30;
  return `<section class="voice" aria-live="polite">
    <div class="voice__row">
      <button id="mic" class="mic ${v === 'listening' ? 'rec' : ''}" ${busy || v === 'confirm' ? 'disabled' : ''} aria-label="${v === 'listening' ? d.stop : d.start}">${v === 'listening' ? STOP : MIC}</button>
      <div class="vstate ${cls}">
        <span class="st"><span class="dot"></span>${title}${v === 'listening' ? ` <span class="timer chrome" id="vtimer">0 / ${max}s</span>` : ''}${v === 'speaking' ? ' <span class="speakbars"><i></i><i></i><i></i><i></i></span>' : ''}</span>
        <span class="dim" style="font-size:13px">${esc(hint)}</span>
      </div>
      ${v === 'listening' ? `<div class="meter on" id="meter">${'<i></i>'.repeat(12)}</div>` : ''}
      ${v === 'speaking' ? `<button id="stop-audio" class="btn btn--ghost btn--sm">${t().tutor.stopPlay}</button>` : ''}
    </div>
    ${
      v === 'confirm' && s.heard !== null
        ? `<div class="heard"><span class="label">${d.heard}</span><q>${esc(s.heard)}</q>
          <div class="row"><button id="confirm" class="btn">${d.confirm}</button><button id="rerecord" class="btn btn--ghost">${d.rerecord}</button></div></div>`
        : ''
    }
    ${s.notice ? `<p class="faint" style="font-size:12px;margin-top:var(--s-3)">${esc(s.notice)}</p>` : ''}
  </section>`;
}

function dialogPanel(): string {
  const d = t().tutor;
  const lastModel = [...s.dialog].reverse().find((m) => m.model)?.model;
  const busy = s.voice === 'thinking' || s.voice === 'transcribing' || s.voice === 'listening';
  return `<aside class="side"><section class="tutor">
    <div class="tutor__head"><span class="label">${d.title}</span><span class="sp"></span>${lastModel ? `<span class="chip">${d.model} · ${esc(lastModel)}</span>` : ''}</div>
    <div class="dialog" id="dialog">${
      s.dialog.length
        ? s.dialog
            .map((m, i) => {
              const text = m.shown !== undefined ? m.text.slice(0, m.shown) : m.text;
              const streaming = m.shown !== undefined && m.shown < m.text.length;
              return `<div class="msg ${m.role} ${streaming ? 'streaming' : ''}" data-msg="${i}">
                <span class="who label">${m.role === 'student' ? d.you : d.tutor}</span><span class="txt">${esc(text)}</span>
                ${m.evidence && !streaming ? `<div class="evidence">${evidenceChips(m.evidence)}</div>` : ''}
                ${m.audio && !streaming ? `<div class="play"><button class="btn btn--ghost btn--sm" data-play="${i}">${d.play}</button></div>` : ''}
              </div>`;
            })
            .join('')
        : `<p class="empty">${esc(d.empty)}</p>`
    }</div>
    <form id="ask" class="ask">
      <input type="text" name="q" placeholder="${esc(d.placeholder)}" autocomplete="off" ${busy ? 'disabled' : ''}/>
      <div class="row"><button class="btn btn--outline btn--sm" ${busy ? 'disabled' : ''}>${d.ask}</button><button type="button" id="explain" class="btn btn--ghost btn--sm" ${busy ? 'disabled' : ''}>${d.explain}</button></div>
    </form>
  </section></aside>`;
}

function html(): string {
  const d = t();
  if (s.loadError) return `<main class="page"><p class="alert alert--err"><b>××</b><span>${esc(s.loadError)}</span></p></main>`;
  if (!s.course) return `<main class="page"><p class="dim">${d.loading}</p></main>`;
  const c = card();
  if (!c || s.allDone)
    return `<main class="page"><div class="stage"><p class="text">${c ? d.allDone : d.home.notReady}</p>
      <div class="stage__foot"><a class="btn" href="#/">${d.review.back}</a><a class="btn btn--ghost" href="#/review/${encodeURIComponent(s.courseId)}">${d.home.check}</a></div></div></main>`;
  const draft = c.review.state !== 'approved';
  const worlds = c.worlds.map((w) => w.world);
  const last = s.index === s.cards.length - 1;
  return `<main class="page">
    <div class="crumbs">
      <a class="label" href="#/">${esc(s.course.title)}</a>
      <span class="chrome">${String(s.index + 1).padStart(2, '0')} / ${String(s.cards.length).padStart(2, '0')}</span>
      ${draft ? `<span class="chip chip--amber">${d.draftMark}</span>` : `<span class="chip chip--ok">🔒 ${d.review.state.approved}</span>`}
      <span style="flex:1"></span>
      ${worlds
        .map((w) => `<button class="world-btn btn--sm ${w === sceneOf(c).world ? 'on' : ''}" style="min-height:34px;padding:6px 10px;font-size:12px" data-world="${esc(w)}">${esc(worldLabel(w))}</button>`)
        .join('')}
    </div>
    ${stepsBar()}
    <div class="learn">
      <section class="stage">
        <div class="kicker label">${d.steps[s.step]} · <span class="dim" style="letter-spacing:0.04em;text-transform:none;font-weight:500">${esc(d.stepHint[s.step])}</span></div>
        <h1>${esc(c.title)}</h1>
        ${stepBody(c)}
        ${isVoiceStep() ? voiceBlock() : ''}
        ${!isVoiceStep() && s.voice === 'speaking' ? voiceBlock() : ''}
        <div class="stage__foot">
          ${s.step === 'feedback' ? `<button id="back-transfer" class="btn btn--ghost">${d.backToTransfer}</button>` : ''}
          ${isVoiceStep() && s.voice !== 'listening' ? `<button id="skip" class="btn btn--ghost btn--sm">${d.voice.skip}</button>` : ''}
          <span class="sp"></span>
          ${s.step === 'feedback' ? `<button id="next" class="btn">${last ? d.allDone.split('.')[0] + ' ✓' : d.nextCard}</button>` : `<button id="next" class="btn" ${s.voice === 'listening' ? 'disabled' : ''}>${d.next}</button>`}
        </div>
      </section>
      ${dialogPanel()}
    </div>
  </main>`;
}

/* ------------------------------------------------------------------ */
/* behaviour                                                           */
/* ------------------------------------------------------------------ */

function stopAudio() {
  if (audio) {
    audio.pause();
    audio = null;
  }
  if (s.voice === 'speaking') s.voice = 'idle';
}

function stopStream() {
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = null;
  for (const m of s.dialog) m.shown = undefined;
}

function meterLoop() {
  cancelAnimationFrame(raf);
  let quietFrames = 0;
  const tick = () => {
    if (s.voice !== 'listening') return;
    const level = recorder.level();
    const bars = document.querySelectorAll<HTMLElement>('#meter i');
    bars.forEach((b, i) => {
      const jitter = 0.6 + 0.4 * Math.abs(Math.sin(performance.now() / 120 + i * 1.7));
      b.style.height = `${Math.max(4, Math.min(28, level * 160 * jitter))}px`;
    });
    const el = document.getElementById('vtimer');
    const sec = Math.floor((performance.now() - s.listenStarted) / 1000);
    if (el) el.textContent = `${sec} / ${card()?.question.maxAnswerSec ?? 30}s`;
    quietFrames = level < SILENCE_PEAK ? quietFrames + 1 : 0;
    const quiet = recorder.recording && sec >= 3 && quietFrames > 90;
    if (quiet !== s.quiet && recorder.problem === null) {
      s.quiet = quiet;
      rerender();
      return void meterLoop();
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

async function startRecording() {
  const c = card();
  if (!c) return;
  stopAudio();
  s.voice = 'listening';
  s.notice = null;
  s.error = null;
  s.quiet = false;
  s.listenStarted = performance.now();
  rerender();
  // Timer and meter run from the press, even while the browser still asks for the microphone.
  meterLoop();
  const res = await recorder.start(c.question.maxAnswerSec, () => void stopRecording());
  if (!res.microphone && s.voice === 'listening') {
    s.notice = res.problem === 'denied' ? `${t().voice.micDenied} ${t().voice.noMic}` : t().voice.noMic;
    rerender();
    meterLoop();
  }
}

async function stopRecording() {
  const c = card();
  if (s.voice !== 'listening' || !c) return;
  cancelAnimationFrame(raf);
  const rec = await recorder.stop();
  if (rec.fromMicrophone && rec.peak !== null && rec.peak < SILENCE_PEAK) {
    s.voice = 'silence';
    rerender();
    return;
  }
  s.voice = 'transcribing';
  rerender();
  try {
    const tr = await api.transcribe(rec.blob, courseLang(), voicePrompt(c, s.step));
    if (!tr.text.trim()) {
      s.voice = 'silence';
    } else {
      s.heard = tr.text.trim();
      s.voice = 'confirm';
    }
  } catch (err) {
    if (err instanceof ApiFailure && err.code === 'no_speech') s.voice = 'silence';
    else {
      s.voice = 'error';
      s.error = errorText(err);
    }
  }
  rerender();
}

function reveal(msg: Msg, onDone: () => void) {
  stopStream();
  msg.shown = 0;
  const step = Math.max(1, Math.round(msg.text.length / 90));
  streamTimer = setInterval(() => {
    msg.shown = Math.min(msg.text.length, (msg.shown ?? 0) + step);
    const i = s.dialog.indexOf(msg);
    const node = document.querySelector<HTMLElement>(`[data-msg="${i}"] .txt`);
    if (node) node.textContent = msg.text.slice(0, msg.shown);
    const box = document.getElementById('dialog');
    if (box) box.scrollTop = box.scrollHeight;
    if (msg.shown >= msg.text.length) {
      clearInterval(streamTimer!);
      streamTimer = null;
      msg.shown = undefined;
      onDone();
    }
  }, 18);
}

function acceptReply(reply: TutorTurnReply, _msg: Msg) {
  if (reply.hintGiven) s.hintsUsed++;
  if (reply.evidence) s.evidence = reply.evidence;
}

function fetchVoice(msg: Msg): Promise<string | null> {
  return api
    .speak(msg.text, courseLang())
    .then((b) => (msg.audio = URL.createObjectURL(b)))
    .catch(() => null);
}

function speakOrNotice(msg: Msg, url: string | null) {
  if (s.dialog.indexOf(msg) < 0) return;
  if (!url) {
    s.voice = 'idle';
    s.notice = t().tutor.voiceOff;
    return rerender();
  }
  play(url);
}

async function askTutor(text: string, kind: 'answer' | 'question' | 'explain_please') {
  const c = card();
  if (!c || !s.course) return;
  stopAudio();
  stopStream();
  if (kind === 'answer') s.answers++;
  s.dialog.push({ role: 'student', text });
  s.voice = 'thinking';
  s.error = null;
  s.notice = null;
  rerender();
  const req = {
    courseId: s.course.id,
    cardId: c.id,
    step: s.step,
    world: sceneOf(c).world,
    language: courseLang(),
    studentText: text,
    kind,
    hintsUsed: s.hintsUsed,
    history: s.dialog.slice(-11, -1).map(({ role, text }) => ({ role, text })),
  };
  try {
    if (isMock()) {
      const reply = await api.tutor(req);
      const msg: Msg = { role: 'tutor', text: reply.text, evidence: reply.evidence, model: reply.model, shown: 0 };
      acceptReply(reply, msg);
      s.dialog.push(msg);
      s.voice = 'speaking';
      rerender();
      const voice = fetchVoice(msg);
      reveal(msg, () => void voice.then((url) => speakOrNotice(msg, url)));
      return;
    }
    // Real server: text arrives as the engine streams it; voice is requested once the turn is complete.
    const msg: Msg = { role: 'tutor', text: '' };
    s.dialog.push(msg);
    rerender();
    const reply = await api.tutorStream(req, (delta) => {
      msg.text += delta;
      const node = document.querySelector<HTMLElement>(`[data-msg="${s.dialog.indexOf(msg)}"] .txt`);
      if (node) node.textContent = msg.text;
      else rerender();
      const box = document.getElementById('dialog');
      if (box) box.scrollTop = box.scrollHeight;
    });
    msg.text = reply.text;
    msg.evidence = reply.evidence;
    msg.model = reply.model;
    acceptReply(reply, msg);
    s.voice = 'speaking';
    rerender();
    speakOrNotice(msg, await fetchVoice(msg));
  } catch (err) {
    s.voice = 'error';
    s.error = errorText(err);
    rerender();
  }
}

function play(url: string) {
  stopAudio();
  const a = new Audio(url);
  audio = a;
  s.voice = 'speaking';
  rerender();
  const done = () => {
    if (audio !== a) return;
    audio = null;
    s.voice = 'idle';
    rerender();
  };
  a.onended = done;
  a.onerror = done;
  a.play().catch(done);
}

function loadImage() {
  const c = card();
  if (!c) return;
  const token = ++s.image.token;
  s.image = { state: 'wait', src: null, token };
  const scene = sceneOf(c);
  if (scene.image) {
    // Pre-rendered at build time (ComfyUI is not live during the demo).
    s.image = { state: 'done', src: scene.image, token };
    return;
  }
  const settle = (job: ImageJob | null) => {
    if (s.image.token !== token) return;
    s.image = { state: job?.state === 'done' ? 'done' : 'failed', src: job?.file ?? null, token };
    rerender();
  };
  (async () => {
    try {
      let job = await api.illustrate(scene.illustration, scene.world);
      for (let i = 0; i < 90 && (job.state === 'queued' || job.state === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (s.image.token !== token) return;
        job = await api.imageJob(job.jobId);
      }
      settle(job);
    } catch {
      settle(null);
    }
  })();
}

function goStep(step: CycleStep) {
  recorder.cancel();
  cancelAnimationFrame(raf);
  stopAudio();
  s.step = step;
  s.voice = 'idle';
  s.heard = null;
  s.notice = null;
  s.error = null;
  if (step === 'explain' && s.image.state === 'none') loadImage();
  rerender();
}

function nextCard() {
  stopStream();
  if (s.index >= s.cards.length - 1) {
    s.allDone = true;
    return rerender();
  }
  s.index++;
  s.dialog = [];
  s.hintsUsed = 0;
  s.answers = 0;
  s.evidence = null;
  s.image = { state: 'none', src: null, token: s.image.token + 1 };
  goStep('hook');
}

export const learnView: View = {
  async enter([courseId]) {
    if (!courseId) return;
    if (s.courseId !== courseId || !s.course) {
      Object.assign(s, { courseId, course: null, cards: [], index: 0, step: 'hook', dialog: [], hintsUsed: 0, answers: 0, evidence: null, allDone: false, loadError: null });
      s.image = { state: 'none', src: null, token: s.image.token + 1 };
    }
    try {
      const course = await api.course(courseId);
      s.course = course;
      s.cards = course.concepts.flatMap((k) => k.cards).filter((c) => isShowable(c, { allowDrafts: app.allowDrafts }));
      if (s.index >= s.cards.length) s.index = 0;
      const c = card();
      if (c && !c.worlds.some((w) => w.world === app.world)) setWorld(c.worlds[0]!.world);
    } catch (err) {
      s.loadError = errorText(err);
    }
  },
  html,
  bind(root) {
    const on = (id: string, fn: () => void) => root.querySelector(`#${id}`)?.addEventListener('click', fn);
    on('mic', () => void (s.voice === 'listening' ? stopRecording() : startRecording()));
    on('confirm', () => {
      const text = s.heard;
      s.heard = null;
      if (text) void askTutor(text, 'answer');
    });
    on('rerecord', () => void startRecording());
    on('stop-audio', () => {
      stopAudio();
      rerender();
    });
    on('skip', () => {
      const n = nextCycleStep(s.step);
      if (n) goStep(n);
    });
    on('next', () => {
      const n = nextCycleStep(s.step);
      if (n) goStep(n);
      else nextCard();
    });
    on('back-transfer', () => goStep('transfer'));
    on('explain', () => void askTutor(t().tutor.explain, 'explain_please'));
    root.querySelector<HTMLFormElement>('#ask')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = new FormData(e.target as HTMLFormElement).get('q')?.toString().trim();
      if (q) void askTutor(q, 'question');
    });
    root.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) =>
      b.addEventListener('click', () => {
        const m = s.dialog[Number(b.dataset.play)];
        if (m?.audio) play(m.audio);
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((b) =>
      b.addEventListener('click', () => {
        setWorld(b.dataset.world!);
        s.image = { state: 'none', src: null, token: s.image.token + 1 };
        if (s.step === 'explain') loadImage();
        rerender();
      }),
    );
    const box = root.querySelector<HTMLElement>('#dialog');
    if (box) box.scrollTop = box.scrollHeight;
  },
  leave() {
    recorder.cancel();
    cancelAnimationFrame(raf);
    stopStream();
    stopAudio();
  },
};
