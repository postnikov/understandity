import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, Course } from '@understandity/contracts';
import type { TurnEntry, VoiceEntry } from '../dialog-log.js';
import { tutorPrompt } from '../tutor-prompt.js';

/**
 * Reading the local dialog log back by learning session: a list for `npm run logs:sessions` and one session as a
 * markdown review document for `npm run logs:review` — the input a strong model reads to improve the tutor prompt.
 * Nothing here calls a model or leaves the machine.
 */
export type LogEntry = TurnEntry | VoiceEntry;

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  courseIds: string[];
  turns: number;
  cards: number;
  models: string[];
  profiles: string[];
}

export interface LogRead {
  entries: LogEntry[];
  /** Turn lines written before sessions existed, or by a client that sent none. */
  withoutSession: number;
  badLines: number;
}

export function readLogs(dir: string): LogRead {
  const out: LogRead = { entries: [], withoutSession: 0, badLines: 0 };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => /^tutor-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        if (e.type !== 'turn' && e.type !== 'voice') continue;
        if (e.type === 'turn' && !e.sessionId) out.withoutSession++;
        out.entries.push(e);
      } catch {
        out.badLines++;
      }
    }
  }
  return out;
}

const uniq = <T>(xs: (T | null | undefined)[]): T[] => [...new Set(xs.filter((x): x is T => x != null))];

export function listSessions(entries: LogEntry[]): SessionSummary[] {
  const by = new Map<string, TurnEntry[]>();
  for (const e of entries) {
    if (e.type !== 'turn' || !e.sessionId) continue;
    by.set(e.sessionId, [...(by.get(e.sessionId) ?? []), e]);
  }
  return [...by.entries()]
    .map(([sessionId, turns]) => {
      const sorted = [...turns].sort((a, b) => a.at.localeCompare(b.at));
      return {
        sessionId,
        startedAt: sorted[0]!.at,
        endedAt: sorted.at(-1)!.at,
        courseIds: uniq(sorted.map((t) => t.courseId)),
        turns: sorted.length,
        cards: uniq(sorted.map((t) => t.cardId)).length,
        models: uniq(sorted.map((t) => (t.model ? `${t.provider ?? '?'}/${t.model}` : null))),
        profiles: uniq(sorted.map((t) => t.profile)),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function formatSessions(list: SessionSummary[], withoutSession = 0): string {
  const rows = list.map((s) =>
    [s.startedAt.slice(0, 16).replace('T', ' '), s.sessionId, s.courseIds.join(','), String(s.turns), s.models.join(',') || '—', s.profiles.join(',')].join('  '),
  );
  const head = ['date (UTC)        ', 'session'.padEnd(36), 'course', 'turns', 'model', 'profile'].join('  ');
  const tail = withoutSession ? [`\n${withoutSession} turn line(s) without a session id (logged before sessions existed).`] : [];
  return [list.length ? head : 'No sessions in the log yet.', ...rows, ...tail].join('\n');
}

const fence = (text: string) => `\`\`\`text\n${text.replace(/```/g, '`​``')}\n\`\`\``;
const quote = (text: string | null) => (text ? text.split('\n').map((l) => `> ${l}`).join('\n') : '> _(no reply)_');
const ms = (v: number | null | undefined) => (typeof v === 'number' ? `${(v / 1000).toFixed(1)} s` : '—');

function findCard(course: Course | undefined, cardId: string): Card | undefined {
  return course?.concepts.flatMap((k) => k.cards).find((c) => c.id === cardId);
}

/** The prompt template a strong model answers; the call itself is a future online-mode step. */
export const REVIEW_TASK = `You are reviewing one learning session of Understandity: a child (12–14) answers by voice, a virtual tutor
replies following the cycle hook → predict → explain → act → transfer → feedback. The first line of the tutor's model
output is a hidden verdict (correct | partial | wrong | unsure | none) that drives hints and moving on.

Read the dialog below step by step and answer:

1. Verdicts. For every turn: was the verdict right for what the child actually said? List each wrong one with the turn
   number, the verdict it should have been and why.
2. Tutor behaviour. Where did the tutor give away the key before the child reached it, confirm a wrong reason, ignore
   the child's own question, talk too long for a 12–14-year-old, or drift from the card's fact? Quote the turn.
3. The child's experience. Where was the child likely confused, bored or stuck? What would have kept the "wow"?
4. Prompt changes. Propose concrete edits to the tutor prompt (shown below for one card): exact sentences to add,
   remove or reword, each tied to the turns it would fix. Keep the rules that worked.
5. Model behaviour. What is a limit of this model (latency, language, following the format) rather than of the
   prompt? Would another engine do better on this session, and at what cost?

Answer in English, as a numbered list per section, most important first.`;

export interface ReviewOptions {
  courses?: Map<string, Course>;
  generatedAt?: Date;
}

export function buildReview(entries: LogEntry[], sessionId: string, opts: ReviewOptions = {}): string {
  const turns = entries.filter((e): e is TurnEntry => e.type === 'turn' && e.sessionId === sessionId).sort((a, b) => a.at.localeCompare(b.at));
  if (!turns.length) throw new Error(`session ${sessionId} not found in the log`);
  const voices = new Map(entries.filter((e): e is VoiceEntry => e.type === 'voice').map((v) => [v.turnId, v]));
  const [summary] = listSessions(turns);
  const s = summary!;
  const courses = opts.courses ?? new Map<string, Course>();
  const verdicts = uniq(turns.map((t) => t.verdict)).map((v) => `${v} ${turns.filter((t) => t.verdict === v).length}`);
  const out: string[] = [
    `# Tutor session review · ${s.startedAt.slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `- Session: \`${sessionId}\``,
    `- Course: ${s.courseIds.map((id) => `${courses.get(id)?.title ?? id} (\`${id}\`)`).join(', ')}`,
    `- Turns: ${s.turns} on ${s.cards} card(s), ${s.startedAt.slice(11, 19)}–${s.endedAt.slice(11, 19)} UTC`,
    `- Tutor model: ${s.models.join(', ') || '—'} · profile: ${s.profiles.join(', ')}`,
    `- Verdicts: ${verdicts.join(', ') || '—'}`,
    `- Generated: ${(opts.generatedAt ?? new Date()).toISOString()} from the local log (\`data/logs\`); no audio is kept.`,
    '',
    '## Task for the reviewing model',
    '',
    REVIEW_TASK,
    '',
    '_Next step (online mode, not built yet): send this file to a strong model (Opus 5.5, Astra or Fable) with the task above and keep its answer next to it in `data/reviews/`._',
    '',
    '## Dialog by card and step',
  ];
  let card = '';
  let step = '';
  turns.forEach((t, i) => {
    if (t.cardId !== card) {
      card = t.cardId;
      step = '';
      const c = findCard(courses.get(t.courseId), t.cardId);
      out.push('', `### Card \`${t.cardId}\`${c ? ` — ${c.title}` : ''}`, '');
      if (c) {
        out.push(
          `- Fact: ${c.fact.statement}`,
          `- Question: ${c.question.prompt}`,
          `- Key (a correct answer must contain): ${c.key.expectedCause}`,
          `- Typical mistake: ${c.key.typicalMistake}`,
          `- World: ${t.world}, language: ${t.language}`,
        );
      }
    }
    if (t.step !== step) {
      step = t.step;
      out.push('', `#### Step: ${t.step}`);
    }
    const v = voices.get(t.turnId);
    out.push(
      '',
      `**Turn ${i + 1}** · ${t.kind} · verdict **${t.verdict ?? '—'}** · hint ${t.hintGiven == null ? '—' : t.hintGiven ? 'yes' : 'no'} · next ${t.next ?? '—'}`,
      '',
      `Child: ${t.student ? `«${t.student}»` : '_(empty)_'}`,
      '',
      'Tutor:',
      '',
      quote(t.tutor),
      '',
      `<sub>${t.provider ?? '?'}/${t.model ?? '?'} · stt ${ms(t.sttMs)} · first words ${ms(t.firstPhraseMs)} · reply ${ms(t.tutorMs)} · voice ${v ? `${ms(v.ttsMs)}${v.error ? ` error ${v.error}` : ''}` : '—'}${t.error ? ` · **error ${t.error}**` : ''}</sub>`,
    );
  });
  const first = turns[0]!;
  const card0 = findCard(courses.get(first.courseId), first.cardId);
  if (card0) {
    out.push(
      '',
      `## Current tutor prompt (card \`${first.cardId}\`, step ${first.step}, answer)`,
      '',
      'The tutor prompt is built per card and step; this is the one for the first turn, as the code builds it today.',
      '',
      fence(tutorPrompt(card0, { language: first.language, world: first.world, step: first.step as never }, 'answer')),
    );
  }
  return `${out.join('\n')}\n`;
}
