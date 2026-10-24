import { isShowable, type Course } from '@understandity/contracts';
import { api, isMock, type CourseSummary } from '../api.js';
import { app, errorText, esc, rerender, setWorld, t, worldLabel } from '../app.js';
import type { View } from '../main.js';

/** Home: pick your world once, then a course. */
const s = {
  loading: true,
  error: null as string | null,
  courses: [] as CourseSummary[],
  full: new Map<string, Course>(),
};

function worlds(): string[] {
  const set = new Set<string>();
  for (const c of s.full.values()) for (const k of c.concepts) for (const card of k.cards) for (const w of card.worlds) set.add(w.world);
  return [...set];
}

function courseCard(c: CourseSummary): string {
  const d = t();
  const full = s.full.get(c.id);
  const counts = c.cards ?? {};
  const total = counts.total ?? 0;
  const showable = full ? full.concepts.flatMap((k) => k.cards).filter((card) => isShowable(card, { allowDrafts: app.allowDrafts })).length : total;
  const approved = counts.approved ?? 0;
  const pending = (counts.needs_review ?? 0) + (counts.draft ?? 0);
  const blocked = counts.blocked ?? 0;
  const seg = (n: number, color: string) => (total && n ? `<span style="width:${(100 * n) / total}%;background:${color}"></span>` : '');
  return `<article class="course">
    <div class="meta">
      <span class="chip">${esc(c.subject)}</span>
      <span class="chip">${esc(c.language.toUpperCase())}</span>
      <span class="chip">${d.home.ages} ${c.ageRange[0]}–${c.ageRange[1]}</span>
    </div>
    <h3>${esc(c.title)}</h3>
    <p class="outcome">${esc(c.outcome)}</p>
    <div class="bar-count" aria-hidden="true">${seg(approved, 'var(--ok)')}${seg(pending, 'var(--amber)')}${seg(blocked, 'var(--danger)')}</div>
    <div class="meta">
      ${approved ? `<span class="chip chip--ok">${approved} ${d.review.state.approved}</span>` : ''}
      ${pending ? `<span class="chip chip--amber">${pending} ${d.review.state.needs_review}</span>` : ''}
      ${blocked ? `<span class="chip chip--danger">${blocked} ${d.review.state.blocked}</span>` : ''}
    </div>
    ${!approved && pending && app.allowDrafts ? `<p class="faint" style="font-size:12px">${d.home.draftsShown}</p>` : ''}
    ${!showable ? `<p class="alert"><b>!</b><span>${d.home.notReady}</span></p>` : ''}
    <div class="actions">
      ${showable ? `<a class="btn" href="#/learn/${encodeURIComponent(c.id)}">${d.home.start} →</a>` : ''}
      <a class="btn btn--ghost" href="#/review/${encodeURIComponent(c.id)}">${d.home.check}</a>
    </div>
  </article>`;
}

export const homeView: View = {
  async enter() {
    s.loading = true;
    s.error = null;
    try {
      s.courses = await api.courses();
      rerender();
      const full = await Promise.all(s.courses.map((c) => api.course(c.id).catch(() => null)));
      full.forEach((c) => c && s.full.set(c.id, c));
      const ws = worlds();
      if (ws.length && !ws.includes(app.world)) setWorld(ws[0]!);
    } catch (err) {
      s.error = errorText(err);
    }
    s.loading = false;
  },
  html() {
    const d = t();
    const ws = worlds();
    return `<main class="page">
      <section class="hero">
        <div>
          <div class="label">${d.home.kicker}</div>
          <h1 style="margin-top:var(--s-3)">${d.home.title}</h1>
          <p class="lead">${esc(d.home.lead)}</p>
        </div>
        <blockquote class="mantra">${esc(d.home.mantra)}<b>${esc(d.home.mantraEnd)}</b></blockquote>
      </section>
      ${
        ws.length
          ? `<div class="sec-head"><h2>${d.home.world}</h2><span class="sp"></span><span class="dim" style="font-size:13px">${esc(d.home.worldHint)}</span></div>
      <div class="worlds">${ws
        .map((w) => `<button class="world-btn ${w === app.world ? 'on' : ''}" data-world="${esc(w)}" aria-pressed="${w === app.world}">${esc(worldLabel(w))}</button>`)
        .join('')}</div>`
          : ''
      }
      <div class="sec-head"><h2>${d.home.courses}</h2><span class="sp"></span><span class="chrome">${s.courses.length}</span></div>
      ${s.error ? `<p class="alert alert--err"><b>××</b><span>${esc(s.error)}</span></p>` : ''}
      ${s.loading && !s.courses.length ? `<p class="dim">${d.loading}</p>` : ''}
      ${!s.loading && !s.error && !s.courses.length ? `<p class="dim">${d.home.empty}</p>` : ''}
      <div class="courses">${s.courses.map(courseCard).join('')}</div>
      ${isMock() ? `<p class="faint" style="font-size:12px;margin-top:var(--s-5)">${esc(d.mockHint)}</p>` : ''}
    </main>`;
  },
  bind(root) {
    root.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((b) =>
      b.addEventListener('click', () => {
        setWorld(b.dataset.world!);
        rerender();
      }),
    );
  },
};
