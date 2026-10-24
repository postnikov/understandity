import './styles.css';
import { CYCLE_STEPS, VOICE_STEPS, nextCycleStep, type Card, type Course, type CycleStep, type EnginesResponse, type Modality, type Settings } from '@understandity/contracts';
import { api, ApiFailure } from './api.js';
import { dict } from './i18n.js';
import { VoiceRecorder } from './recorder.js';

type Phase = 'idle' | 'recording' | 'transcribing' | 'confirm' | 'thinking';

interface State {
  course: Course | null;
  card: Card | null;
  cardIndex: number;
  step: CycleStep;
  world: string;
  phase: Phase;
  heard: string | null;
  notice: string | null;
  dialog: { role: 'student' | 'tutor'; text: string; audio?: string }[];
  hintsUsed: number;
  image: string | null;
  settingsOpen: boolean;
  engines: EnginesResponse | null;
  draft: Settings | null;
  settingsMsg: string | null;
}

const s: State = {
  course: null,
  card: null,
  cardIndex: 0,
  step: 'hook',
  world: 'fantasy',
  phase: 'idle',
  heard: null,
  notice: null,
  dialog: [],
  hintsUsed: 0,
  image: null,
  settingsOpen: false,
  engines: null,
  draft: null,
  settingsMsg: null,
};
const recorder = new VoiceRecorder();
const root = document.querySelector<HTMLDivElement>('#app')!;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const lang = () => s.course?.language ?? 'ru';
const t = () => dict(s.engines?.settings.language ?? lang());

function allCards(course: Course): Card[] {
  return course.concepts.flatMap((c) => c.cards);
}

function voicePrompt(card: Card, step: CycleStep): string {
  if (step === 'predict') return card.hook.predictPrompt;
  if (step === 'act') return card.action.instruction;
  return card.question.prompt;
}

function stepBody(card: Card, step: CycleStep): string {
  const scene = card.worlds.find((w) => w.world === s.world) ?? card.worlds[0]!;
  switch (step) {
    case 'hook':
      return `<p class="hook">${esc(card.hook.question)}</p><p class="scene">${esc(scene.scene)}</p>`;
    case 'predict':
      return `<p class="prompt">${esc(card.hook.predictPrompt)}</p>`;
    case 'explain':
      return `<p>${esc(card.explanation)}</p>${s.image ? `<img class="scheme" alt="${esc(scene.illustration)}" src="${s.image}">` : ''}`;
    case 'act':
      return `<p class="prompt">${esc(card.action.instruction)}</p><p class="muted">≠ ${esc(card.action.changedCondition)} · = ${esc(card.action.constants.join(', '))}</p>`;
    case 'transfer':
      return `<p class="prompt">${esc(card.question.prompt)}</p>`;
    case 'feedback':
      return `<p>${esc(t().done)}</p>`;
  }
}

function render() {
  const d = t();
  const card = s.card;
  const isVoice = VOICE_STEPS.includes(s.step);
  const profile = s.engines?.settings.profile ?? 'offline';
  root.innerHTML = `
    <header>
      <div class="logo">understandity</div>
      <span class="badge ${profile}">${profile === 'offline' ? d.offline : d.online}</span>
      <label class="world">${d.world}
        <select id="world">${(card?.worlds ?? []).map((w) => `<option ${w.world === s.world ? 'selected' : ''}>${esc(w.world)}</option>`).join('')}</select>
      </label>
      <button id="open-settings" class="ghost">⚙ ${d.engines}</button>
    </header>
    ${
      card
        ? `<main class="card">
      <ol class="steps">${CYCLE_STEPS.map((st) => `<li class="${st === s.step ? 'on' : CYCLE_STEPS.indexOf(st) < CYCLE_STEPS.indexOf(s.step) ? 'past' : ''}">${d.steps[st]}</li>`).join('')}</ol>
      <h1>${esc(card.title)}</h1>
      <section class="body">${stepBody(card, s.step)}</section>
      ${
        isVoice
          ? `<section class="voice">
        ${s.phase === 'recording' ? `<button id="stop" class="rec on">${d.stop}</button><span class="muted">${esc(s.notice ?? d.recording)}</span>` : ''}
        ${s.phase === 'idle' ? `<button id="record" class="rec">${d.record}</button>` : ''}
        ${s.phase === 'transcribing' ? `<span class="muted">…</span>` : ''}
        ${
          s.phase === 'confirm' && s.heard
            ? `<div class="heard"><span class="muted">${d.heard}</span> «${esc(s.heard)}»
               <div class="row"><button id="confirm">${d.confirm}</button><button id="rerecord" class="ghost">${d.rerecord}</button></div></div>`
            : ''
        }
        ${s.phase === 'thinking' ? `<span class="muted">${d.thinking}</span>` : ''}
      </section>`
          : ''
      }
      ${s.notice && s.phase !== 'recording' ? `<p class="notice">${esc(s.notice)}</p>` : ''}
      <section class="dialog">${s.dialog
        .map(
          (m, i) =>
            `<div class="msg ${m.role}">${esc(m.text)}${m.audio ? ` <button class="ghost play" data-i="${i}">${d.play}</button>` : ''}</div>`,
        )
        .join('')}</section>
      <form id="ask" class="ask">
        <input name="q" placeholder="${esc(d.askPlaceholder)} — ${esc(card.askTutor)}" />
        <button>${d.ask}</button>
        <button type="button" id="explain" class="ghost">${d.explain}</button>
      </form>
      <footer><button id="next">${d.next}</button></footer>
    </main>`
        : '<main class="card"><p class="muted">…</p></main>'
    }
    ${s.settingsOpen ? renderSettings() : ''}
  `;
  bind();
}

function renderSettings(): string {
  const d = t();
  const eng = s.engines;
  const draft = s.draft;
  if (!eng || !draft) return '';
  const modalities: Modality[] = ['text', 'stt', 'tts', 'image'];
  const rows = modalities
    .map((m) => {
      const providers = eng.providers.filter((p) => p.modality === m);
      const sel = draft.engines[m];
      const current = providers.find((p) => p.provider === sel.provider);
      const providerOpts = providers
        .map(
          (p) =>
            `<option value="${esc(p.provider)}" ${p.provider === sel.provider ? 'selected' : ''}>${esc(p.label)} · ${p.locality === 'cloud' ? d.cloud : d.local}${p.health ? '' : ` · ${d.notWired}`}</option>`,
        )
        .join('');
      const modelOpts = (current?.models ?? [])
        .map((mo) => `<option ${mo.id === sel.model ? 'selected' : ''}>${esc(mo.id)}</option>`)
        .join('');
      const h = current?.health?.state ?? 'down';
      return `<div class="eng"><b>${m.toUpperCase()}</b><span class="dot ${h}" title="${esc(current?.health?.detail ?? '')}"></span>
        <select data-m="${m}" class="prov">${providerOpts}</select>
        <select data-m="${m}" class="model">${modelOpts}</select></div>`;
    })
    .join('');
  return `<aside class="settings">
    <h2>${d.engines}</h2>
    <label>${d.profile}
      <select id="profile"><option value="offline" ${draft.profile === 'offline' ? 'selected' : ''}>${d.offline}</option><option value="online" ${draft.profile === 'online' ? 'selected' : ''}>${d.online}</option></select>
    </label>
    <p class="muted">${d.profileHint}</p>
    ${rows}
    <div class="row"><button id="save">${d.save}</button><button id="close-settings" class="ghost">✕</button></div>
    ${s.settingsMsg ? `<pre class="issues">${esc(s.settingsMsg)}</pre>` : ''}
  </aside>`;
}

function bind() {
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  on('record', startRecording);
  on('stop', stopRecording);
  on('confirm', confirmTranscript);
  on('rerecord', () => ((s.phase = 'idle'), (s.heard = null), render()));
  on('next', nextStep);
  on('explain', () => void askTutor(t().explain, 'explain_please'));
  on('open-settings', openSettings);
  on('close-settings', () => ((s.settingsOpen = false), render()));
  on('save', saveSettings);
  document.getElementById('world')?.addEventListener('change', (e) => {
    s.world = (e.target as HTMLSelectElement).value;
    s.image = null;
    render();
  });
  document.getElementById('ask')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.target as HTMLFormElement).get('q')?.toString().trim();
    if (q) void askTutor(q, 'question');
  });
  document.querySelectorAll<HTMLButtonElement>('.play').forEach((b) =>
    b.addEventListener('click', () => {
      const m = s.dialog[Number(b.dataset.i)];
      if (m?.audio) void new Audio(m.audio).play();
    }),
  );
  document.getElementById('profile')?.addEventListener('change', (e) => {
    if (s.draft) s.draft.profile = (e.target as HTMLSelectElement).value as Settings['profile'];
  });
  document.querySelectorAll<HTMLSelectElement>('select.prov').forEach((sel) =>
    sel.addEventListener('change', () => {
      const m = sel.dataset.m as Modality;
      const p = s.engines?.providers.find((x) => x.modality === m && x.provider === sel.value);
      if (s.draft && p) s.draft.engines[m] = { provider: p.provider, model: p.models[0]?.id ?? '', voice: null };
      render();
    }),
  );
  document.querySelectorAll<HTMLSelectElement>('select.model').forEach((sel) =>
    sel.addEventListener('change', () => {
      const m = sel.dataset.m as Modality;
      if (s.draft) s.draft.engines[m].model = sel.value;
    }),
  );
}

async function startRecording() {
  s.phase = 'recording';
  s.notice = null;
  render();
  const { microphone } = await recorder.start(s.card?.question.maxAnswerSec ?? 30, () => void stopRecording());
  if (!microphone && s.phase === 'recording') {
    s.notice = t().noMic;
    render();
  }
}

async function stopRecording() {
  if (s.phase !== 'recording' || !s.card) return;
  const rec = await recorder.stop();
  s.phase = 'transcribing';
  render();
  try {
    const tr = await api.transcribe(rec.blob, lang(), voicePrompt(s.card, s.step));
    s.heard = tr.text;
    s.phase = 'confirm';
    s.notice = rec.fromMicrophone ? null : t().noMic;
  } catch (err) {
    s.phase = 'idle';
    s.notice = err instanceof ApiFailure && err.code === 'no_speech' ? t().noAnswer : String((err as Error).message);
  }
  render();
}

async function confirmTranscript() {
  if (!s.heard) return;
  const text = s.heard;
  s.heard = null;
  await askTutor(text, 'answer');
}

async function askTutor(text: string, kind: 'answer' | 'question' | 'explain_please') {
  if (!s.card || !s.course) return;
  s.dialog.push({ role: 'student', text });
  s.phase = 'thinking';
  s.notice = null;
  render();
  try {
    const reply = await api.tutor({
      courseId: s.course.id,
      cardId: s.card.id,
      step: s.step,
      world: s.world,
      language: lang(),
      studentText: text,
      kind,
      hintsUsed: s.hintsUsed,
      history: s.dialog.slice(-10, -1).map(({ role, text }) => ({ role, text })),
    });
    if (reply.hintGiven) s.hintsUsed++;
    const entry: State['dialog'][number] = { role: 'tutor', text: reply.text };
    s.dialog.push(entry);
    s.phase = 'idle';
    render();
    // Text first, voice after: feedback is readable immediately, audio catches up.
    try {
      const audio = await api.speak(reply.text, lang());
      entry.audio = URL.createObjectURL(audio);
      render();
      void new Audio(entry.audio).play().catch(() => undefined);
    } catch (err) {
      s.notice = `TTS: ${(err as Error).message}`;
      render();
    }
  } catch (err) {
    s.phase = 'idle';
    s.notice = (err as Error).message;
    render();
  }
}

async function nextStep() {
  if (!s.course || !s.card) return;
  const n = nextCycleStep(s.step);
  s.phase = 'idle';
  s.notice = null;
  if (n) {
    s.step = n;
    if (n === 'explain' && !s.image) {
      const scene = s.card.worlds.find((w) => w.world === s.world) ?? s.card.worlds[0]!;
      api
        .illustrate(scene.illustration, s.world)
        .then((job) => ((s.image = job.file), render()))
        .catch(() => undefined);
    }
  } else {
    const cards = allCards(s.course);
    s.cardIndex = (s.cardIndex + 1) % cards.length;
    s.card = cards[s.cardIndex]!;
    s.step = 'hook';
    s.dialog = [];
    s.hintsUsed = 0;
    s.image = null;
  }
  render();
}

async function openSettings() {
  s.engines = await api.engines();
  s.draft = structuredClone(s.engines.settings);
  s.settingsMsg = null;
  s.settingsOpen = true;
  render();
}

async function saveSettings() {
  if (!s.draft) return;
  const res = await api.saveSettings(s.draft);
  s.settingsMsg = res.ok ? t().saved : res.issues.map((i) => `✗ ${i.message}`).join('\n');
  s.engines = await api.engines();
  if (res.ok) s.draft = structuredClone(res.settings);
  render();
}

async function boot() {
  const [course, engines] = await Promise.all([api.course(), api.engines()]);
  s.course = course;
  s.engines = engines;
  s.world = engines.settings.world;
  s.card = allCards(course)[0] ?? null;
  document.documentElement.lang = course.language;
  render();
}

render();
boot().catch((err) => {
  root.innerHTML = `<main class="card"><p class="notice">API: ${esc(String(err))}</p></main>`;
});
