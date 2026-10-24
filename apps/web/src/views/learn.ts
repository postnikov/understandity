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
import { app, errorText, esc, isLangEnabled, subjectLabel, rerender, setLang, setWorld, t, UI_LANGS, worldLabel, answerLimitSec } from '../app.js';
import type { UiLang } from '../i18n.js';
import type { View } from '../main.js';
import { SILENCE_PEAK, VoiceRecorder } from '../recorder.js';
import { sceneArt } from '../scenes.js';
import { isOnRequest } from '../generate.js';

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
  /** Server id of the tutor turn; the voice request carries it so the dialog log joins text and voice. */
  turnId?: string;
}

const s = {
  /** Speech recognition time of the last recorded answer, sent with the tutor turn for the dialog log. */
  lastSttMs: null as number | null,
  /** One learning session = one opened course and the cards gone through; every logged turn carries it. */
  sessionId: '',
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
  // What the tutor noticed, as short sentences a 12-year-old reads at a glance (no tags, no scores).
  const d = t().evidence;
  const items = [
    e.prediction ? `${d.prediction}: «${esc(e.prediction)}»` : '',
    d.cause[e.cause] ? `<b class="${e.cause === 'correct' ? 'ok' : ''}">${esc(d.cause[e.cause])}</b>` : '',
    d.transfer[e.transfer] ? `<b class="${e.transfer === 'independent' ? 'ok' : ''}">${esc(d.transfer[e.transfer])}</b>` : '',
    e.hintsUsed ? `${d.hints}: ${e.hintsUsed}` : '',
  ].filter(Boolean);
  return `<ul class="evidence-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
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
    <div class="eyebrow">${esc(subjectLabel(s.course!.subject))} / ${two(s.index + 1)}</div>
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
    <div class="scene">${art.html}<span class="art-stamp">${esc(worldLabel(scene.world))} / ${esc(subjectLabel(s.course!.subject))}</span>
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
      ${m.evidence && !streaming ? `${evidenceChips(m.evidence)}` : ''}
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
  const max = answerLimitSec(c.question.maxAnswerSec);
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
          <div class="formula"><span class="label">${o.oneSentence}</span>${esc(c.fact.statement)}</div>${panelBottom(`<button id="next" class="btn btn--block">${o.gotIt} <span aria-hidden="true">→</span></button>`)}`,
      };
    case 'feedback':
      return {
        cls: '',
        html: `<span class="pill">${SPARK}${d.steps.feedback}</span><p class="copy">${esc(s.answers ? d.wrap : d.wrapNone)}</p>
          ${s.evidence ? evidenceChips(s.evidence) : ''}
          ${yourWords()}
          ${panelBottom(nextBtn, `<button id="back-transfer" class="btn btn--ghost btn--block">${d.backToTransfer}</button>`)}`,
      };
    case 'act':
      // «Try it»: the child-facing instruction is the main text; what changes and what stays are a quiet hint.
      return {
        cls: 'voice-idle',
        html: `<span class="pill accent">${SPARK}${o.tryPill}</span><p class="lead-text">${esc(c.action.instruction)}</p>
          <p class="copy dim">${o.tryHint}</p>
          <details class="vars-hint"><summary>${o.varsSummary}</summary><dl class="vars">
            <dt>${o.whatChanges}</dt><dd>${esc(c.action.changedCondition)}</dd>
            ${c.action.constants.length ? `<dt>${o.whatStays}</dt><dd>${esc(c.action.constants.join(' · '))}</dd>` : ''}
          </dl></details>${alert}${notice}
          ${panelBottom(`<button id="mic" class="btn btn--block btn--mic">${MIC}<span>${o.tryAnswer}</span></button>`, `<div class="row-split">${typing}<button id="skip" class="text-btn text-btn--dim">${d.voice.skip}</button></div>`)}`,
      };
    default: {
      // predict / transfer: the question is the big heading; the panel says how to answer, in plain words.
      const guess = s.step === 'predict';
      return {
        cls: 'voice-idle',
        html: `<span class="pill accent">${MIC}${guess ? o.yourTurn : o.newCasePill}</span><h2>${guess ? o.guessTitle : o.newCaseTitle}</h2><p class="copy">${esc(d.stepHint[s.step])}</p>${alert}${notice}
          ${panelBottom(`<button id="mic" class="btn btn--block btn--mic">${MIC}<span>${guess ? o.guessAnswer : o.newCaseAnswer}</span></button>`, `<div class="row-split">${typing}<button id="skip" class="text-btn text-btn--dim">${d.voice.skip}</button></div>`)}`,
      };
    }
  }
}

/** The student's own words in this card — the point of the cycle is explaining it yourself. */
function yourWords(): string {
  const words = s.dialog.filter((m) => m.role === 'student' && m.text !== t().tutor.explain).map((m) => m.text);
  if (!words.length) return '';
  return `<div class="your-words"><span class="label">${t().ocean.yourWords}</span>${words.map((w) => `<q>${esc(w)}</q>`).join('')}</div>`;
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
          ${isOnRequest(s.course) ? `<span class="chip chip--amber ai-mark">${d.make.aiMark}</span>` : draft ? `<span class="chip chip--amber">${d.draftMark}</span>` : ''}
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
  const res = await recorder.start(answerLimitSec(c.question.maxAnswerSec), () => void stopRecording());
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
    const sttStart = performance.now();
    const tr = await api.transcribe(rec.blob, courseLang(), voicePrompt(c, s.step));
    s.lastSttMs = Math.round(performance.now() - sttStart);
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
    .speak(msg.text, courseLang(), msg.turnId)
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
    // Only a spoken answer has a recognition time; a typed question does not.
    clientTimings: { sttMs: kind === 'answer' ? s.lastSttMs : null },
    sessionId: s.sessionId,
  };
  s.lastSttMs = null;
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
    msg.turnId = (reply as { turnId?: string }).turnId;
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
    // A new session when another course opens (or none is loaded); moving between cards keeps it.
    if (s.courseId !== courseId || !s.course || !s.sessionId) s.sessionId = crypto.randomUUID();
    if (s.courseId !== courseId || !s.course || (wanted !== null && wanted !== s.index)) {
      Object.assign(s, { courseId, course: null, cards: [], index: wanted ?? 0, step: 'hook', dialog: [], hintsUsed: 0, answers: 0, evidence: null, allDone: false, loadError: null, stepMark: 0, askOpen: false });
      s.visited = new Set<number>();
    }
    try {
      const course = await api.course(courseId);
      s.course = course;
      // A child reads one language on the lesson screen: the chrome follows the course (EN/RU switch still works).
      // Only when more than one UI language is enabled (UI_LANGS); English-only build keeps the chrome in English.
      const cl = course.language.slice(0, 2);
      if (UI_LANGS.length > 1 && isLangEnabled(cl) && cl !== app.lang) setLang(cl as UiLang);
      // Courses made on request open right away as drafts (contract); prepared courses still need an adult's approval.
      s.cards = course.concepts.flatMap((k) => k.cards).filter((c) => isShowable(c, { allowDrafts: app.allowDrafts || isOnRequest(course) }));
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
