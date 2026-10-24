import { isShowable, type Card, type Course } from '@understandity/contracts';
import { api, isMock, type CourseSummary } from '../api.js';
import { app, errorText, esc, subjectLabel, rerender, t } from '../app.js';
import type { View } from '../main.js';
import { sceneArt } from '../scenes.js';

/** Home (Ocean lab): one big question per course, its scene, and the path of discoveries (cards). */
const s = {
  loading: true,
  error: null as string | null,
  courses: [] as CourseSummary[],
  full: new Map<string, Course>(),
  selected: localStorage.getItem('understandity.course') ?? '',
};

const MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true"><rect x="9" y="2" width="6" height="13"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>`;

const cardsOf = (c: Course) => c.concepts.flatMap((k) => k.cards);
const showableOf = (c: Course) => cardsOf(c).filter((card) => isShowable(card, { allowDrafts: app.allowDrafts }));

/** Course title with the last word in the accent colour, as in the prototype hero. */
function heroTitle(title: string): string {
  const m = /^(.*?)(\S+)$/.exec(title.trim());
  return m ? `${esc(m[1])}<em>${esc(m[2])}</em>` : esc(title);
}

function discovery(course: Course, card: Card, i: number, learnIndex: number): string {
  const open = learnIndex >= 0;
  const art = sceneArt({ course, card, index: i, world: app.world, labels: false, fit: 'meet' });
  const n = String(i + 1).padStart(2, '0');
  const inner = `<div class="map-art">${art.html}</div><div class="map-body"><span class="n">${n}</span><span>${esc(card.title)}</span></div>`;
  return open
    ? `<a class="map-card" href="#/learn/${encodeURIComponent(course.id)}/${learnIndex}">${inner}</a>`
    : `<div class="map-card locked" title="${esc(t().home.waiting)}">${inner}<span class="lock">${esc(t().home.waiting)}</span></div>`;
}

function hero(course: Course): string {
  const d = t();
  const showable = showableOf(course);
  const first = showable[0] ?? cardsOf(course)[0] ?? null;
  const art = sceneArt({ course, card: first, index: 0, world: app.world, labels: course.language.startsWith('en') });
  const all = cardsOf(course);
  return `<section class="home-hero">
    <div class="home-copy">
      <div class="eyebrow">${d.home.adventure} ${esc(subjectLabel(course.subject))}</div>
      <h1>${heroTitle(course.title)}</h1>
      <p class="lead">${esc(course.outcome)}</p>
      <div class="home-actions">
        ${
          showable.length
            ? `<a class="btn btn--xl" href="#/learn/${encodeURIComponent(course.id)}">${d.home.go} <span aria-hidden="true">→</span></a><span class="dim">${d.home.curiosity}</span>`
            : `<p class="alert"><b>!</b><span>${d.home.notReady}</span></p>`
        }
      </div>
      <p class="home-meta">${all.length} ${d.home.discoveries} <i>·</i> ${d.home.ages} ${course.ageRange[0]}–${course.ageRange[1]} <i>·</i> ${d.home.byTalking}
        <i>·</i> <a href="#/review/${encodeURIComponent(course.id)}">${d.home.check}</a></p>
    </div>
    <div class="hero-art">${art.html}
      <span class="art-stamp">${d.home.worth}</span>
      ${first ? `<div class="art-caption"><span>${esc(first.title)}</span></div>` : ''}
    </div>
  </section>`;
}

export const homeView: View = {
  async enter() {
    s.loading = true;
    s.error = null;
    try {
      s.courses = await api.courses();
      const full = await Promise.all(s.courses.map((c) => api.course(c.id).catch(() => null)));
      full.forEach((c) => c && s.full.set(c.id, c));
      if (!s.courses.some((c) => c.id === s.selected)) {
        // Default: the first course a student can actually open.
        const open = s.courses.find((c) => s.full.get(c.id) && showableOf(s.full.get(c.id)!).length);
        s.selected = (open ?? s.courses[0])?.id ?? '';
      }
    } catch (err) {
      s.error = errorText(err);
    }
    s.loading = false;
  },
  html() {
    const d = t();
    if (s.error) return `<main class="page"><p class="alert alert--err"><b>××</b><span>${esc(s.error)}</span></p></main>`;
    if (s.loading && !s.courses.length) return `<main class="page"><p class="dim">${d.loading}</p></main>`;
    if (!s.courses.length) return `<main class="page"><p class="dim">${d.home.empty}</p></main>`;
    const course = s.full.get(s.selected) ?? null;
    const showIds = course ? showableOf(course).map((c) => c.id) : [];
    return `<main class="page home">
      ${
        s.courses.length > 1
          ? `<nav class="course-tabs" aria-label="${esc(d.home.pick)}"><span class="label">${d.home.pick}</span>${s.courses
              .map((c) => `<button data-course="${esc(c.id)}" class="${c.id === s.selected ? 'on' : ''}" aria-pressed="${c.id === s.selected}">${esc(c.title)}</button>`)
              .join('')}</nav>`
          : ''
      }
      ${course ? hero(course) : `<p class="dim">${d.loading}</p>`}
      ${
        course
          ? `<section class="module-map">
        <div class="section-head"><span class="label">${d.home.yourDiscoveries}</span><span class="dim">${d.home.nextLeads}</span></div>
        <div class="card-grid">${cardsOf(course)
          .filter((c) => c.review.state !== 'blocked')
          .map((c, i) => discovery(course, c, i, showIds.indexOf(c.id)))
          .join('')}</div>
        <p class="mic-line">${MIC}<span>${d.home.micLine}</span></p>
      </section>`
          : ''
      }
      ${isMock() ? `<p class="faint" style="font-size:12px;margin-top:var(--s-5)">${esc(d.mockHint)}</p>` : ''}
    </main>`;
  },
  bind(root) {
    root.querySelectorAll<HTMLButtonElement>('[data-course]').forEach((b) =>
      b.addEventListener('click', () => {
        s.selected = b.dataset.course!;
        localStorage.setItem('understandity.course', s.selected);
        rerender();
      }),
    );
  },
};
