import type { Card, Course, ReviewState } from '@understandity/contracts';
import { api, type CourseSummary, type ReviewEdits, type ReviewStatusChoice } from '../api.js';
import { errorText, esc, rerender, t } from '../app.js';
import type { View } from '../main.js';

/**
 * Adult gate: every card's chain «fact → question → key» is approved, blocked or fixed by a person
 * before a child sees it. Blocked cards never reach the student screen.
 */
const s = {
  courseId: '',
  list: [] as CourseSummary[],
  course: null as Course | null,
  error: null as string | null,
  editing: null as string | null,
  saving: null as string | null,
  flash: null as string | null,
  filter: 'all' as 'all' | ReviewState,
};

const stateChip = (st: ReviewState) => {
  const cls = st === 'approved' ? 'chip--ok' : st === 'blocked' ? 'chip--danger' : 'chip--amber';
  return `<span class="chip ${cls}"><span class="dot"></span>${t().review.state[st]}</span>`;
};

function cardRow(card: Card): string {
  const d = t().review;
  const st = card.review.state;
  const editing = s.editing === card.id;
  const saving = s.saving === card.id;
  return `<article class="rcard ${st}" id="card-${esc(card.id)}">
    <div class="rcard__head">
      <span class="chrome">${esc(card.id)}</span>
      <h3>${esc(card.title)}</h3>
      <span class="sp"></span>
      ${s.flash === card.id ? `<span class="chip chip--accent">${d.saved}</span>` : ''}
      ${stateChip(st)}
    </div>
    <div class="chain">
      <div>
        <span class="label">01 · ${d.fact}</span>
        <p class="v">${esc(card.fact.statement)}</p>
        ${card.fact.conditions.length ? `<p class="sub"><b>${d.conditions}:</b> ${esc(card.fact.conditions.join(' · '))}</p>` : ''}
        <p class="sub"><b>${d.source}:</b> ${card.fact.source ? esc(card.fact.source) : `<span style="color:var(--amber)">${d.noSource}</span>`}</p>
      </div>
      <div>
        <span class="label">02 · ${d.question}</span>
        <p class="v">${esc(card.question.prompt)}</p>
        <p class="sub">${esc(card.hook.question)}</p>
      </div>
      <div>
        <span class="label">03 · ${d.key}</span>
        <p class="v">${esc(card.key.expectedCause)}</p>
        <p class="sub"><b>${d.mistake}:</b> ${esc(card.key.typicalMistake)}</p>
        <p class="sub"><b>${d.followUp}:</b> ${esc(card.key.followUp)}</p>
      </div>
    </div>
    ${card.review.notes.length ? `<div class="rcard__notes">${card.review.notes.map((n) => `! ${esc(n)}`).join('<br>')}</div>` : ''}
    ${
      editing
        ? `<form class="rcard__edit" data-edit="${esc(card.id)}">
        <label class="field"><span class="label">${d.fact}</span><textarea name="fact">${esc(card.fact.statement)}</textarea></label>
        <label class="field"><span class="label">${d.question}</span><textarea name="question">${esc(card.question.prompt)}</textarea></label>
        <label class="field"><span class="label">${d.key}</span><textarea name="key">${esc(card.key.expectedCause)}</textarea></label>
        <div style="grid-column:1/-1;display:flex;gap:var(--s-2)"><button class="btn btn--ok">${d.saveEdit}</button><button type="button" class="btn btn--ghost" data-cancel>${d.cancel}</button></div>
      </form>`
        : `<div class="rcard__foot">
        <button class="btn btn--ok btn--sm" data-act="approved" data-card="${esc(card.id)}" ${saving || st === 'approved' ? 'disabled' : ''}>${d.approve}</button>
        <button class="btn btn--danger btn--sm" data-act="blocked" data-card="${esc(card.id)}" ${saving || st === 'blocked' ? 'disabled' : ''}>${d.block}</button>
        <button class="btn btn--ghost btn--sm" data-act="edit" data-card="${esc(card.id)}" ${saving ? 'disabled' : ''}>${d.edit}</button>
        <span class="sp"></span>
        ${card.review.reviewedAt ? `<span class="faint" style="font-size:12px">${esc(card.review.reviewer ?? '')} · ${esc(card.review.reviewedAt.slice(11, 16))}</span>` : ''}
      </div>`
    }
  </article>`;
}

function html(): string {
  const d = t();
  if (s.error) return `<main class="page"><p class="alert alert--err"><b>××</b><span>${esc(s.error)}</span></p></main>`;
  if (!s.courseId)
    return `<main class="page"><div class="label">${d.review.kicker}</div><h1 style="margin:var(--s-3) 0 var(--s-5)">${d.review.pick}</h1>
      <div class="courses">${s.list
        .map(
          (c) => `<a class="course" style="text-decoration:none;color:inherit" href="#/review/${encodeURIComponent(c.id)}"><h3>${esc(c.title)}</h3><p class="outcome">${esc(c.outcome)}</p>
          <div class="meta">${stateChip(c.review.state)}<span class="chip">${c.cards?.total ?? '?'} ${d.home.cards}</span></div></a>`,
        )
        .join('')}</div></main>`;
  if (!s.course) return `<main class="page"><p class="dim">${d.loading}</p></main>`;
  const cards = s.course.concepts.flatMap((k) => k.cards.map((card) => ({ concept: k, card })));
  const count = (st: ReviewState) => cards.filter((x) => x.card.review.state === st).length;
  const tally = (['approved', 'needs_review', 'draft', 'blocked'] as ReviewState[])
    .filter((st) => count(st) > 0)
    .map(
      (st) =>
        `<button class="chip ${s.filter === st ? 'chip--accent' : ''}" data-filter="${st}" style="cursor:pointer">${count(st)} · ${d.review.state[st]}</button>`,
    )
    .join('');
  const shown = cards.filter((x) => s.filter === 'all' || x.card.review.state === s.filter);
  let lastConcept = '';
  return `<main class="page">
    <div class="crumbs"><a class="label" href="#/">${d.review.back}</a></div>
    <div class="review-head">
      <div>
        <div class="label">${d.review.kicker} · ${esc(s.course.subject)} · ${esc(s.course.language.toUpperCase())}</div>
        <h1 style="margin-top:var(--s-2)">${esc(s.course.title)}</h1>
        <p class="dim" style="margin-top:var(--s-3);max-width:46em">${esc(d.review.lead)}</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:var(--s-3);align-items:flex-end">
        <div class="tally"><button class="chip ${s.filter === 'all' ? 'chip--accent' : ''}" data-filter="all" style="cursor:pointer">${cards.length} · ${d.home.cards}</button>${tally}</div>
        ${count('approved') || count('needs_review') || count('draft') ? `<a class="btn btn--outline btn--sm" href="#/learn/${encodeURIComponent(s.course.id)}">${d.review.learn}</a>` : ''}
      </div>
    </div>
    ${s.course.review.notes.length ? `<p class="alert" style="margin-top:var(--s-4)"><b>!</b><span>${s.course.review.notes.map(esc).join('<br>')}</span></p>` : ''}
    ${shown
      .map(({ concept, card }) => {
        const head =
          concept.id !== lastConcept
            ? `<div class="sec-head"><h2>${esc(concept.title)}</h2><span class="sp"></span><span class="dim" style="font-size:13px">${esc(concept.centralCause)}</span></div>`
            : '';
        lastConcept = concept.id;
        return head + cardRow(card);
      })
      .join('')}
  </main>`;
}

async function decide(cardId: string, status: ReviewStatusChoice, edits?: ReviewEdits) {
  if (!s.course) return;
  s.saving = cardId;
  rerender();
  try {
    const res = await api.review(s.course.id, { cardId, status, ...(edits ? { edits } : {}) });
    // The server may answer with the whole course or the updated card; refetch on a card to stay simple.
    s.course = 'concepts' in res ? res : await api.course(s.course.id);
    s.editing = null;
    s.flash = cardId;
    setTimeout(() => {
      if (s.flash === cardId) {
        s.flash = null;
        rerender();
      }
    }, 1600);
  } catch (err) {
    s.error = errorText(err);
  }
  s.saving = null;
  rerender();
}

export const reviewView: View = {
  async enter([courseId]) {
    s.error = null;
    s.editing = null;
    s.courseId = courseId ?? '';
    if (!courseId) {
      s.course = null;
      try {
        s.list = await api.courses();
        if (s.list.length === 1) location.replace(`#/review/${encodeURIComponent(s.list[0]!.id)}`);
      } catch (err) {
        s.error = errorText(err);
      }
      return;
    }
    if (s.course?.id !== courseId) s.course = null;
    try {
      s.course = await api.course(courseId);
    } catch (err) {
      s.error = errorText(err);
    }
  },
  html,
  bind(root) {
    root.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.card!;
        if (b.dataset.act === 'edit') {
          s.editing = id;
          return rerender();
        }
        void decide(id, b.dataset.act as ReviewStatusChoice);
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        s.filter = b.dataset.filter as typeof s.filter;
        rerender();
      }),
    );
    root.querySelectorAll<HTMLFormElement>('[data-edit]').forEach((f) => {
      f.querySelector('[data-cancel]')?.addEventListener('click', () => {
        s.editing = null;
        rerender();
      });
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const card = s.course?.concepts.flatMap((k) => k.cards).find((c) => c.id === f.dataset.edit);
        if (!card) return;
        const fd = new FormData(f);
        const val = (k: string) => fd.get(k)?.toString().trim() ?? '';
        const edits: ReviewEdits = {};
        if (val('fact') && val('fact') !== card.fact.statement) edits.fact = { statement: val('fact') };
        if (val('question') && val('question') !== card.question.prompt) edits.question = { prompt: val('question') };
        if (val('key') && val('key') !== card.key.expectedCause) edits.key = { expectedCause: val('key') };
        void decide(card.id, 'approved', Object.keys(edits).length ? edits : undefined);
      });
    });
  },
};
