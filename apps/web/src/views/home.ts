import { isShowable, type Course } from '@understandity/contracts';
import { api, isMock, type CourseSummary } from '../api.js';
import { app, errorText, esc, subjectLabel, t } from '../app.js';
import type { View } from '../main.js';
import { sceneArt } from '../scenes.js';
import { isOnRequest } from '../generate.js';
import { bindMake, leaveMake, makePanel, refreshKeys } from './make.js';

/**
 * Home = landing (word of Max, 24.10 15:49): what this is and for whom, a clear «Make your own course» button,
 * and every course as a card that opens it. The course hero and the generator live on their own screens.
 */
const s = {
  loading: true,
  error: null as string | null,
  courses: [] as CourseSummary[],
  full: new Map<string, Course>(),
};

const cardsOf = (c: Course) => c.concepts.flatMap((k) => k.cards);
/** Courses made on request are shown right away as drafts (contract, word of Max); prepared courses need approval. */
const showableOf = (c: Course) =>
  app.gateOff ? cardsOf(c) : cardsOf(c).filter((card) => isShowable(card, { allowDrafts: app.allowDrafts || isOnRequest(c) }));

function courseCard(course: Course): string {
  const d = t();
  const showable = showableOf(course);
  const first = showable[0] ?? cardsOf(course)[0] ?? null;
  const art = sceneArt({ course, card: first, index: 0, world: app.world, labels: false });
  const n = cardsOf(course).length;
  const mine = isOnRequest(course);
  const body = `<div class="ccard__art">${art.html}<span class="ccard__subject">${esc(subjectLabel(course.subject))}</span></div>
    <div class="ccard__body">
      <h3>${esc(course.title)}</h3>
      ${first ? `<p class="ccard__q">${esc(first.hook.question)}</p>` : ''}
      <div class="ccard__foot"><span class="dim">${n} ${d.home.discoveries}${mine && !app.gateOff ? ` · <span class="ai-mark-inline">${d.make.aiMark}</span>` : ''}</span>
        ${showable.length ? `<span class="ccard__go">${d.home.open} →</span>` : `<span class="ccard__wait">${d.home.waiting}</span>`}</div>
    </div>`;
  return showable.length
    ? `<a class="ccard" href="#/learn/${encodeURIComponent(course.id)}">${body}</a>`
    : `<div class="ccard ccard--locked">${body}</div>`;
}

function grid(label: string, hint: string, list: Course[]): string {
  if (!list.length) return '';
  return `<section class="courses-sec">
    <div class="section-head"><span class="label">${label}</span><span class="dim">${hint}</span></div>
    <div class="course-grid">${list.map(courseCard).join('')}</div>
  </section>`;
}

export const homeView: View = {
  async enter() {
    s.loading = true;
    s.error = null;
    try {
      await refreshKeys();
      s.courses = await api.courses();
      const full = await Promise.all(s.courses.map((c) => api.course(c.id).catch(() => null)));
      full.forEach((c) => c && s.full.set(c.id, c));
    } catch (err) {
      s.error = errorText(err);
    }
    s.loading = false;
  },
  html() {
    const d = t();
    const courses = s.courses.map((c) => s.full.get(c.id)).filter((c): c is Course => !!c);
    const prepared = courses.filter((c) => !isOnRequest(c));
    const mine = courses.filter((c) => isOnRequest(c));
    return `<main class="page home landing">
      <section class="intro">
        <div class="intro__copy">
          <div class="eyebrow">${d.home.kicker}</div>
          <h1>${esc(d.home.landingTitle)}</h1>
          <p class="lead">${esc(d.home.landingLead)}</p>
          <blockquote class="mantra">${esc(d.home.mantra)}<b>${esc(d.home.mantraEnd)}</b></blockquote>
        </div>
        <div class="intro__make">${makePanel()}</div>
      </section>
      ${s.error ? `<p class="alert alert--err"><b>××</b><span>${esc(s.error)}</span></p>` : ''}
      ${s.loading && !courses.length ? `<p class="dim">${d.loading}</p>` : ''}
      ${!s.loading && !s.error && !courses.length ? `<p class="dim">${d.home.empty}</p>` : ''}
      ${grid(d.make.yourCourses, d.home.yourCoursesHint, mine)}
      ${grid(d.home.courses, d.home.coursesHint, prepared)}
      ${isMock() ? `<p class="faint" style="font-size:12px;margin-top:var(--s-5)">${esc(d.mockHint)}</p>` : ''}
    </main>`;
  },
  bind(root) {
    // The form lives right on the landing (Max, 24.10 16:08); progress and the ready screen open on #/make.
    bindMake(root);
  },
  leave() {
    leaveMake();
  },
};
