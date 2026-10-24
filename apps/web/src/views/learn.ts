import {
  CYCLE_STEPS,
  VOICE_STEPS,
  isShowable,
  nextCycleStep,
  type Card,
  type Course,
  type CycleStep,
  type Evidence,
  type TutorTurnReply,
} from '@understandity/contracts';
import { api, ApiFailure, isMock } from '../api.js';
import { app, errorText, esc, rerender, setWorld, t, worldLabel } from '../app.js';
import type { View } from '../main.js';
import { SILENCE_PEAK, VoiceRecorder } from '../recorder.js';
import { sceneArt } from '../scenes.js';

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
  allDone: false,
  listenStarted: 0,
  quiet: false,
  /** Dialog length when the current step began: replies after it belong to this step. */
  stepMark: 0,
  visited: new Set<number>(),
  askOpen: false,
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

/* ------------------------------------------------------------------ */
/* rendering (Ocean lab: sidebar path · stepper · big question ·       */
/* scene + panel). Logic below the rendering block is unchanged.        */
/* ------------------------------------------------------------------ */

const MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><rect x="9" y="2" width="6" height="13"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>`;
const STOP = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/></svg>`;
const SPARK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7Z"/></svg>`;
const CHAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3h18v14H9l-6 4Z"/></svg>`;
const GUIDE = `<img class="guide-mark" src="/brand/icon.svg" alt="" aria-hidden="true">`;
const BARS = 32;

const two = (n: number) => String(n).padStart(2, '0');
const clock = (sec: number) => `${Math.floor(sec / 60)}:${two(sec % 60)}`;

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

function heading(c: Card): string {
  switch (s.step) {
    case 'hook':
      return c.hook.question;
    case 'predict':
      return c.hook.predictPrompt;
    case 'explain':
      return c.title;
    case 'act':
      // The instruction itself lives in the panel, next to the scene and the mic; the heading only frames the step.
      return t().ocean.tryHeading;
    case 'transfer':
      return c.question.prompt;
    case 'feedback':
      return t().ocean.reflectTitle;
  }
}

function sidebar(): string {
  const d = t().ocean;
  const n = s.cards.length;
  return `<aside class="sidebar">
    <a class="back" href="#/">${d.back}</a>
    <div class="eyebrow">${esc(s.course!.subject)} / ${two(s.index + 1)}</div>
    <h2>${esc(s.course!.title)}</h2>
    <div class="course-progress"><span>${d.discoveries}</span><span>${s.visited.size} / ${n} ${d.explored}</span></div>
    <div class="progress-track">${s.cards.map((_, i) => `<i class="${s.visited.has(i) ? 'on' : ''}"></i>`).join('')}</div>
    <nav class="side-cards">${s.cards
      .map((c, i) => `<button data-card="${i}" class="side-card ${i === s.index ? 'current' : ''}" ${i === s.index ? 'aria-current="true"' : ''}><span class="n">${two(i + 1)}</span><span>${esc(c.title)}</span></button>`)
      .join('')}</nav>
    <div class="side-note"><b>${d.noWords}</b><p>${d.noWordsText}</p></div>
  </aside>`;
}

function stepper(): string {
  const d = t();
  const cur = CYCLE_STEPS.indexOf(s.step);
  return `<ol class="stepper" aria-label="steps">${CYCLE_STEPS.map(
    (st, i) =>
      `<li><button data-step="${st}" class="cycle-step ${i === cur ? 'active' : i < cur ? 'done' : ''}" ${i === cur ? 'aria-current="step"' : ''}><span class="n">${two(i + 1)}</span><span class="nm">${d.steps[st]}</span></button></li>`,
  ).join('')}</ol>`;
}

function sceneCol(c: Card): string {
  const d = t().ocean;
  const scene = sceneOf(c);
  const art = sceneArt({ course: s.course, card: c, index: s.index, world: scene.world, labels: courseLang().startsWith('en') });
  return `<div class="scene-col">
    <div class="scene">${art.html}<span class="art-stamp">${esc(worldLabel(scene.world))} / ${esc(s.course!.subject)}</span>
      <div class="art-caption"><span>${d.observe}</span></div></div>
    <div class="world-text"><span class="eyebrow eyebrow--plain">${esc(d.yourWorld(worldLabel(scene.world)))}</span><p>${esc(scene.scene)}</p></div>
  </div>`;
}

/** Tutor reply of the current step, if any: `data-msg`/`.txt` stay, the SSE stream writes into them. */
function tutorBlock(): string {
  const d = t();
  const v = s.voice;
  const i = s.dialog.length - 1;
  const m = s.dialog[i]!;
  const student = [...s.dialog.slice(s.stepMark)].reverse().find((x) => x.role === 'student');
  const text = m.shown !== undefined ? m.text.slice(0, m.shown) : m.text;
  const streaming = (m.shown !== undefined && m.shown < m.text.length) || (v === 'thinking' && !m.model);
  return `<div class="guide">
      <div class="guide-head">${GUIDE}<div><b>${d.ocean.guide}</b><span>${
        v === 'speaking' ? `${d.voice.speaking} <span class="speakbars"><i></i><i></i><i></i><i></i></span>` : m.model ? `${d.tutor.model} · ${esc(m.model)}` : d.voice.tutorThinking
      }</span></div></div>
      ${student ? `<p class="you-said"><b>${d.ocean.youSaid}:</b> ${esc(student.text)}</p>` : ''}
      <div class="msg tutor ${streaming ? 'streaming' : ''}" data-msg="${i}"><span class="txt">${esc(text)}</span></div>
      ${m.evidence && !streaming ? `<div class="evidence">${evidenceChips(m.evidence)}</div>` : ''}
      <div class="guide-tools">
        ${v === 'speaking' ? `<button id="stop-audio" class="btn btn--ghost btn--sm">${d.tutor.stopPlay}</button>` : ''}
        ${m.audio && v !== 'speaking' && !streaming ? `<button class="btn btn--ghost btn--sm" data-play="${i}">${d.tutor.play}</button>` : ''}
      </div>
    </div>`;
}

function panelBottom(primary: string, extra = ''): string {
  return `<div class="panel-bottom">${primary}${extra}</div>`;
}

function panel(c: Card): { cls: string; html: string } {
  const d = t();
  const o = d.ocean;
  const v = s.voice;
  const max = c.question.maxAnswerSec;
  const last = s.dialog[s.dialog.length - 1];
  const hasReply = s.dialog.length > s.stepMark && last?.role === 'tutor';
  const nextBtn = `<button id="next" class="btn btn--block">${s.step === 'feedback' ? (s.index >= s.cards.length - 1 ? d.allDone : d.nextCard) : `${o.nextStep} <span aria-hidden="true">→</span>`}</button>`;
  const typing = `<button class="text-btn" data-ask-open>${o.typing}</button>`;
  const notice = s.notice ? `<p class="small dim">${esc(s.notice)}</p>` : '';

  if (v === 'listening') {
    return {
      cls: 'voice-panel',
      html: `<div class="eyebrow">${o.yourTurn}</div><h2>${o.listening}</h2>
        <p class="voice-caption">${esc(s.quiet ? d.voice.quiet : d.voice.listeningHint)}</p>
        <div class="waveform" id="meter" aria-hidden="true">${'<i></i>'.repeat(BARS)}</div>
        <p class="timer"><b id="vtimer">0:00</b> / ${clock(max)}</p>${notice}
        ${panelBottom(`<button id="mic" class="btn btn--block">${STOP}<span>${o.done}</span></button>`)}`,
    };
  }
  if (v === 'confirm' && s.heard !== null) {
    return {
      cls: 'voice-panel',
      html: `<div class="eyebrow">${d.voice.heard}</div><h2>${o.heardTitle}</h2>
        <q class="heard-q">${esc(s.heard)}</q><p class="voice-caption">${d.voice.checkHint}</p>${notice}
        ${panelBottom(`<button id="confirm" class="btn btn--block">${d.voice.confirm}</button>`, `<button id="rerecord" class="btn btn--ghost btn--block">${MIC}<span>${d.voice.rerecord}</span></button>`)}`,
    };
  }
  if (v === 'transcribing' || (v === 'thinking' && !hasReply)) {
    return {
      cls: 'voice-panel',
      html: `<div class="eyebrow">${d.voice.thinking}</div><h2>${o.thinking}</h2>
        <p class="voice-caption">${v === 'transcribing' ? d.voice.transcribing : d.voice.tutorThinking}</p><div class="dots" aria-hidden="true"><i></i><i></i><i></i></div>`,
    };
  }
  const alert =
    v === 'silence'
      ? `<p class="alert"><b>!</b><span><strong>${d.voice.silence}.</strong> ${d.voice.silenceHint}</span></p>`
      : v === 'error'
        ? `<p class="alert alert--err"><b>××</b><span><strong>${d.voice.error}.</strong> ${esc(s.error ?? '')}</span></p>`
        : '';
  if (hasReply) {
    return {
      cls: 'tutor-panel',
      html: `${tutorBlock()}${alert}${notice}${panelBottom(
        nextBtn,
        isVoiceStep() && v !== 'speaking' && v !== 'thinking' ? `<button id="mic" class="btn btn--ghost btn--block">${MIC}<span>${o.answerAgain}</span></button>` : '',
      )}`,
    };
  }
  switch (s.step) {
    case 'hook':
      return {
        cls: '',
        html: `<span class="pill">${SPARK}${o.surprising}</span><h2>${o.notAdd}</h2><p class="copy">${esc(d.stepHint.hook)}</p>
          <p class="quote">${o.guessHint}</p>${panelBottom(`<button id="next" class="btn btn--block">${o.theory} <span aria-hidden="true">→</span></button>`)}`,
      };
    case 'explain':
      return {
        cls: '',
        html: `<span class="pill">${SPARK}${o.cause}</span><p class="copy">${esc(c.explanation)}</p>
          <p class="formula">${esc(c.fact.statement)}</p>${panelBottom(`<button id="next" class="btn btn--block">${o.gotIt} <span aria-hidden="true">→</span></button>`)}`,
      };
    case 'feedback':
      return {
        cls: '',
        html: `<span class="pill">${SPARK}${d.steps.feedback}</span><p class="copy">${esc(s.answers ? d.wrap : d.wrapNone)}</p>
          ${s.evidence ? `<div class="evidence">${evidenceChips(s.evidence)}</div>` : ''}
          ${panelBottom(nextBtn, `<button id="back-transfer" class="btn btn--ghost btn--block">${d.backToTransfer}</button>`)}`,
      };
    case 'act':
      // «Try it»: the child-facing instruction is the main text; what changes and what stays are a quiet hint.
      return {
        cls: '',
        html: `<span class="pill accent">${SPARK}${o.tryPill}</span><p class="lead-text">${esc(c.action.instruction)}</p>
          <p class="copy dim">${o.tryHint}</p>
          <details class="vars-hint"><summary>${o.varsSummary}</summary><dl class="vars">
            <dt>${o.whatChanges}</dt><dd>${esc(c.action.changedCondition)}</dd>
            ${c.action.constants.length ? `<dt>${o.whatStays}</dt><dd>${esc(c.action.constants.join(' · '))}</dd>` : ''}
          </dl></details>${alert}${notice}
          ${panelBottom(`<button id="mic" class="btn btn--block btn--mic">${MIC}<span>${o.tryAnswer}</span></button>`, `<div class="row-split">${typing}<button id="skip" class="text-btn text-btn--dim">${d.voice.skip}</button></div>`)}`,
      };
    default: {
      return {
        cls: '',
        html: `<span class="pill accent">${MIC}${o.yourTurn}</span><h2>${o.sayIt}</h2><p class="copy">${esc(d.stepHint[s.step])}</p>${alert}${notice}
          ${panelBottom(`<button id="mic" class="btn btn--block btn--mic">${MIC}<span>${d.voice.start}</span></button>`, `<div class="row-split">${typing}<button id="skip" class="text-btn text-btn--dim">${d.voice.skip}</button></div>`)}`,
      };
    }
  }
}

function askBox(): string {
  const d = t().tutor;
  const busy = s.voice === 'thinking' || s.voice === 'transcribing' || s.voice === 'listening';
  return `<form id="ask" class="ask-box">
    <input type="text" name="q" placeholder="${esc(d.placeholder)}" autocomplete="off" ${busy ? 'disabled' : ''}/>
    <button class="btn btn--sm" ${busy ? 'disabled' : ''}>${d.ask}</button>
    <button type="button" id="explain" class="btn btn--ghost btn--sm" ${busy ? 'disabled' : ''}>${d.explain}</button>
  </form>`;
}

function earlier(): string {
  const prior = s.dialog.slice(0, s.stepMark);
  if (!prior.length) return '';
  const d = t();
  return `<details class="earlier"><summary>${d.ocean.earlier} · ${prior.length}</summary>${prior
    .map((m) => `<p class="${m.role}"><b>${m.role === 'student' ? d.tutor.you : d.tutor.tutor}:</b> ${esc(m.text)}</p>`)
    .join('')}</details>`;
}

function html(): string {
  const d = t();
  if (s.loadError) return `<main class="page"><p class="alert alert--err"><b>××</b><span>${esc(s.loadError)}</span></p></main>`;
  if (!s.course) return `<main class="page"><p class="dim">${d.loading}</p></main>`;
  const c = card();
  if (!c || s.allDone)
    return `<main class="page summary"><div class="eyebrow">${esc(s.course.title)}</div><h1>${c ? d.ocean.allDoneTitle : d.home.notReady}</h1>
      <div class="home-actions"><a class="btn btn--xl" href="#/">${d.ocean.back}</a><a class="text-btn" href="#/review/${encodeURIComponent(s.courseId)}">${d.home.check}</a></div></main>`;
  const q = heading(c);
  const p = panel(c);
  const worlds = c.worlds.map((w) => w.world);
  const draft = c.review.state !== 'approved';
  return `<main class="page learn-page" data-voice="${s.voice}">
    <div class="learn-layout">
      ${sidebar()}
      <section class="lesson">
        <div class="learn-top">
          <div class="eyebrow">${two(s.index + 1)} / ${two(s.cards.length)} · ${esc(c.title)}</div>
          ${draft ? `<span class="chip chip--amber">${d.draftMark}</span>` : ''}
          <div class="world-toggle" role="group">${worlds
            .map((w) => `<button data-world="${esc(w)}" class="${w === sceneOf(c).world ? 'active' : ''}" aria-pressed="${w === sceneOf(c).world}">${esc(worldLabel(w))}</button>`)
            .join('')}</div>
        </div>
        ${stepper()}
        <h1 class="lesson-q ${q.length > 110 ? 'long' : ''}">${esc(q)}</h1>
        <div class="lesson-card ${p.cls ? 'panel-first' : ''}">${sceneCol(c)}<div class="lesson-panel ${p.cls}" aria-live="polite">${p.html}</div></div>
        <div class="lesson-foot"><span>${d.ocean.noScore}</span><button class="text-btn" data-ask-open>${CHAT}<span>${d.ocean.ask}</span></button></div>
        ${s.askOpen ? askBox() : ''}
        ${earlier()}
      </section>
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
      // Waveform: live level when the meter works, a calm idle wave otherwise.
      b.style.height = `${Math.max(8, Math.min(72, 10 + level * 520 * jitter + 10 * jitter))}px`;
    });
    const el = document.getElementById('vtimer');
    const sec = Math.floor((performance.now() - s.listenStarted) / 1000);
    if (el) el.textContent = clock(sec);
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

function goStep(step: CycleStep) {
  recorder.cancel();
  cancelAnimationFrame(raf);
  stopAudio();
  s.step = step;
  s.voice = 'idle';
  s.heard = null;
  s.notice = null;
  s.error = null;
  s.stepMark = s.dialog.length;
  s.visited.add(s.index);
  rerender();
}

function openCard(index: number) {
  stopStream();
  s.index = index;
  s.allDone = false;
  s.dialog = [];
  s.hintsUsed = 0;
  s.answers = 0;
  s.evidence = null;
  goStep('hook');
}

function nextCard() {
  stopStream();
  if (s.index >= s.cards.length - 1) {
    s.allDone = true;
    return rerender();
  }
  openCard(s.index + 1);
}

export const learnView: View = {
  async enter([courseId, cardIndex]) {
    if (!courseId) return;
    const wanted = cardIndex !== undefined && /^\d+$/.test(cardIndex) ? Number(cardIndex) : null;
    if (s.courseId !== courseId || !s.course || (wanted !== null && wanted !== s.index)) {
      Object.assign(s, { courseId, course: null, cards: [], index: wanted ?? 0, step: 'hook', dialog: [], hintsUsed: 0, answers: 0, evidence: null, allDone: false, loadError: null, stepMark: 0, askOpen: false });
      s.visited = new Set<number>();
    }
    try {
      const course = await api.course(courseId);
      s.course = course;
      s.cards = course.concepts.flatMap((k) => k.cards).filter((c) => isShowable(c, { allowDrafts: app.allowDrafts }));
      if (s.index >= s.cards.length) s.index = 0;
      s.visited.add(s.index);
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
        rerender();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-card]').forEach((b) => b.addEventListener('click', () => openCard(Number(b.dataset.card))));
    root.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        if (s.voice !== 'listening') goStep(b.dataset.step as CycleStep);
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-ask-open]').forEach((b) =>
      b.addEventListener('click', () => {
        s.askOpen = !s.askOpen;
        rerender();
        if (s.askOpen) root.querySelector<HTMLInputElement>('#ask input')?.focus();
      }),
    );
  },
  leave() {
    recorder.cancel();
    cancelAnimationFrame(raf);
    stopStream();
    stopAudio();
  },
};
