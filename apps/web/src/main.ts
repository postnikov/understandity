import './styles.css';
import { api, isMock } from './api.js';
import { ADULT_CHECK, app, esc, setLang, setRerender, t, UI_LANGS } from './app.js';
import type { UiLang } from './i18n.js';
import { homeView } from './views/home.js';
import { learnView } from './views/learn.js';
import { reviewView } from './views/review.js';
import { enginesView } from './views/engines.js';

/**
 * Shell: top bar + hash router. Routes:
 *   #/                  course choice
 *   #/learn/<courseId>  learning cycle of a course
 *   #/review[/<id>]     adult gate
 *   #/engines           provider and model per modality
 */
export interface View {
  /** Called when the route is entered; may load data, then calls render via the shell. */
  enter(params: string[]): void | Promise<void>;
  html(): string;
  bind(root: HTMLElement): void;
  leave?(): void;
}

// The review screen stays in the code; with the adult check off its route falls back to the course list.
const views: Record<string, View> = { '': homeView, learn: learnView, ...(ADULT_CHECK ? { review: reviewView } : {}), engines: enginesView };
const root = document.querySelector<HTMLDivElement>('#app')!;
let current: View = homeView;
let routeName = '';

function parse(): [string, string[]] {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const name = parts[0] && views[parts[0]] ? parts[0] : '';
  return [name, parts.slice(1)];
}

function bar(): string {
  const d = t();
  const profile = app.engines?.settings.profile ?? null;
  const link = (name: string, label: string) => `<a href="#/${name}" class="${routeName === name ? 'on' : ''}">${label}</a>`;
  return `<header class="bar"><div class="bar__in">
    <a class="brand" href="#/" aria-label="Understandity"><img src="/brand/lockup.svg" alt="Understandity"></a>
    <span class="tagline">${d.tagline}</span>
    <nav class="nav">${link('', d.nav.home)}${ADULT_CHECK ? link('review', d.nav.review) : ''}${link('engines', d.nav.engines)}</nav>
    <span class="bar__sp"></span>
    ${isMock() ? `<span class="chip chip--amber" title="${esc(d.mockHint)}">${d.mock}</span>` : ''}
    ${profile ? `<span class="chip ${profile === 'offline' ? 'chip--ok' : 'chip--amber'}"><span class="dot"></span>${profile === 'offline' ? d.offline : d.online}</span>` : ''}
    ${
      UI_LANGS.length > 1
        ? `<div class="lang" role="group" aria-label="Language">${UI_LANGS.map(
            (l) => `<button data-lang="${l}" class="${app.lang === l ? 'on' : ''}" aria-pressed="${app.lang === l}">${l.toUpperCase()}</button>`,
          ).join('')}</div>`
        : ''
    }
  </div></header>`;
}

function render() {
  const scrollY = window.scrollY;
  root.innerHTML = `${bar()}<div id="view">${current.html()}</div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-lang]').forEach((b) =>
    b.addEventListener('click', () => {
      setLang(b.dataset.lang as UiLang);
      render();
    }),
  );
  current.bind(root.querySelector<HTMLElement>('#view')!);
  window.scrollTo(0, scrollY);
}
setRerender(render);

async function route() {
  const [name, params] = parse();
  current.leave?.();
  if (name !== routeName) window.scrollTo(0, 0);
  routeName = name;
  current = views[name]!;
  render();
  await current.enter(params);
  render();
}

async function boot() {
  setLang(app.lang);
  window.addEventListener('hashchange', () => void route());
  api
    .engines()
    .then((e) => {
      app.engines = e;
      if (!app.world) app.world = e.settings.world;
      render();
    })
    .catch(() => undefined);
  await route();
}

void boot();
