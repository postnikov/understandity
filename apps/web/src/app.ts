import type { EnginesResponse } from '@understandity/contracts';
import { dict, type Dict, type UiLang } from './i18n.js';

/**
 * Languages the product shows right now — UI and courses. Hackathon build is English only (word of Max, 24.10 14:31);
 * Russian strings and courses stay in code and content: add 'ru' here to bring the switch, RU courses and the
 * lesson's follow-the-course-language back in one edit.
 */
export const UI_LANGS: readonly UiLang[] = ['en'];

/**
 * Adult check (review gate) for this build. Off today (Max, 24.10): no Adult check screen, no "not checked by an
 * adult" marks, every course opens for the student whatever its review state. The review code stays; set to true
 * to bring it back (and `adultCheck` in config/features.json for the server).
 */
export const ADULT_CHECK = false;

/** Longest spoken answer, seconds (Max, 24.10: up to 60). A card may allow more, never less. */
export const ANSWER_LIMIT_SEC = 60;
export const answerLimitSec = (cardMaxSec: number | undefined) => Math.max(cardMaxSec ?? 0, ANSWER_LIMIT_SEC);
export const isLangEnabled = (lang: string) => (UI_LANGS as readonly string[]).includes(lang.slice(0, 2));

const storedLang = localStorage.getItem('understandity.lang') as UiLang | null;

/** App-wide state shared by the views. Each view keeps its own local state. */
export const app = {
  lang: storedLang && UI_LANGS.includes(storedLang) ? storedLang : UI_LANGS[0]!,
  world: localStorage.getItem('understandity.world') ?? '',
  engines: null as EnginesResponse | null,
  /** Demo opt-in: show `draft`/`needs_review` cards to the student with a visible mark. Blocked never. */
  allowDrafts: import.meta.env.VITE_ALLOW_DRAFTS === '1',
  /** With the adult check off, every card is open to the student, whatever its review state. */
  get gateOff() {
    return !ADULT_CHECK;
  },
};

export const t = (): Dict => dict(app.lang);

export function setLang(lang: UiLang) {
  if (!UI_LANGS.includes(lang)) lang = UI_LANGS[0]!;
  app.lang = lang;
  localStorage.setItem('understandity.lang', lang);
  document.documentElement.lang = lang;
}

export function setWorld(world: string) {
  app.world = world;
  localStorage.setItem('understandity.world', world);
}

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Subject label in the UI language; unknown subjects pass through as written in the course. */
export const subjectLabel = (subject: string) => t().subjects[subject.toLowerCase()] ?? subject;

export const worldLabel = (w: string) => t().worlds[w] ?? w.charAt(0).toUpperCase() + w.slice(1);

/** Re-render hook set by the shell; views call it after state changes. */
export let rerender: () => void = () => undefined;
export function setRerender(fn: () => void) {
  rerender = fn;
}

export function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.message?.includes('Failed to fetch')) return t().apiDown;
  return e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? err);
}
