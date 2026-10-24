import {
  TutorTurnRequestSchema,
  findCard,
  isShowable,
  type Course,
  type NextMove,
  type TextResult,
  type TutorTurnReply,
  type TutorTurnRequest,
  type Evidence,
} from '@understandity/contracts';
import { tutorPrompt } from './tutor-prompt.js';
import { EngineError } from '@understandity/contracts';
import type { EngineHub } from './engines.js';

/** Resolves a course by id at call time, so approved key edits from the adult gate reach the tutor at once. */
export type CourseLookup = (courseId: string) => Promise<Course | null>;

export interface TutorMeta {
  verdict: Verdict | null;
  provider: string;
  model: string;
  /** From the start of the turn to the first words the child sees (the VERDICT line is not counted). */
  firstPhraseMs: number | null;
  totalMs: number;
  kind: 'answer' | 'question' | 'explain_please';
}

export interface TutorOptions {
  /** Same rule as the child screen: unreviewed cards are not tutored unless drafts are explicitly allowed. */
  allowDrafts: boolean;
  /** Called with every text delta while the engine streams. */
  onDelta?: (text: string) => void;
  /** Called once with what the dialog log needs and the reply does not carry. */
  onMeta?: (meta: TutorMeta) => void;
  signal?: AbortSignal;
}

/** The tutor's own judgement of the last answer, emitted as a first line `VERDICT: …` and stripped before display. */
export type Verdict = 'correct' | 'partial' | 'wrong' | 'unsure' | 'none';
const VERDICT_RE = /^\s*\**\s*VERDICT\s*:\s*(correct|partial|wrong|unsure|none)\b[^\n]*\n?/i;

/**
 * Strips a leading `VERDICT: x` line from a text stream while passing everything else through as it arrives.
 * Buffers only until the first line is complete (or clearly not a verdict), so streaming stays live.
 */
export function verdictFilter(onDelta?: (text: string) => void) {
  let head = '';
  let decided = false;
  let verdict: Verdict | null = null;
  const flush = (text: string) => text && onDelta?.(text);
  return {
    push(delta: string) {
      if (decided) return flush(delta);
      head += delta;
      const nl = head.indexOf('\n');
      const h = head.replace(/^\s*\**\s*/, '').toUpperCase();
      const looksLikeTag = h.length < 7 ? 'VERDICT'.startsWith(h) : h.startsWith('VERDICT');
      if (nl < 0 && looksLikeTag && head.length < 48) return; // wait for the rest of the tag line
      decided = true;
      const m = VERDICT_RE.exec(head);
      if (m) {
        verdict = m[1]!.toLowerCase() as Verdict;
        flush(head.slice(m[0].length).replace(/^\s+/, ''));
      } else flush(head);
    },
    finish(full: string): { text: string; verdict: Verdict | null } {
      if (!decided) {
        // the whole reply was shorter than a tag line: release it now
        decided = true;
        const mh = VERDICT_RE.exec(head);
        if (mh) verdict = mh[1]!.toLowerCase() as Verdict;
        flush(mh ? head.slice(mh[0].length).replace(/^\s+/, '') : head);
      }
      const m = VERDICT_RE.exec(full);
      return m ? { text: full.slice(m[0].length).trim(), verdict: (verdict ?? m[1]!.toLowerCase()) as Verdict } : { text: full.trim(), verdict };
    },
  };
}

/**
 * A hint is counted only when the student asked for help or the tutor actually guided after a
 * not-yet-right answer. A correct answer or the student's own question is never a hint.
 */
export function countsAsHint(kind: 'answer' | 'question' | 'explain_please', verdict: Verdict | null): boolean {
  if (kind === 'explain_please') return true;
  if (kind === 'question') return false;
  return verdict === 'partial' || verdict === 'wrong' || verdict === 'unsure';
}

const NEXT: Record<Verdict, NextMove> = {
  correct: 'deeper',
  partial: 'ask_why',
  wrong: 'counterexample',
  unsure: 'other_metaphor',
  none: 'ask_why',
};

function evidenceOf(verdict: Verdict | null, req: { step: string; studentText: string }, hintsUsed: number): Evidence | null {
  if (!verdict || verdict === 'none') return null;
  const cause = verdict === 'correct' ? 'correct' : verdict === 'wrong' ? 'incorrect' : 'missing';
  const transfer =
    req.step !== 'transfer' ? 'unknown' : verdict !== 'correct' ? 'not_yet' : hintsUsed === 0 ? 'independent' : 'with_hints';
  return { prediction: null, cause, transfer, hintsUsed, quote: req.studentText.slice(0, 200) };
}

/**
 * One tutor turn: card goal + key + recent dialogue → one short question or explanation.
 * The model also judges the answer (`VERDICT:` line): that drives the hint counter, `next` and a minimal `evidence`.
 */
export async function tutorTurn(
  hub: EngineHub,
  lookup: CourseLookup,
  input: TutorTurnRequest,
  opts: TutorOptions,
): Promise<TutorTurnReply> {
  const req = TutorTurnRequestSchema.parse(input);
  const course = await lookup(req.courseId);
  if (!course) throw new EngineError('bad_input', `course "${req.courseId}" not found`);
  const found = findCard(course, req.cardId);
  if (!found) throw new EngineError('bad_input', `card "${req.cardId}" not found in "${req.courseId}"`);
  const { card } = found;
  if (!isShowable(card, { allowDrafts: opts.allowDrafts })) {
    throw new EngineError('bad_input', `card "${card.id}" is not approved by an adult yet`);
  }

  // Two real hints on this task → direct explanation instead of a third guess. The student's own questions don't count.
  const kind = req.kind === 'answer' && req.hintsUsed >= 2 ? 'explain_please' : req.kind;
  const messages = [
    { role: 'system' as const, content: tutorPrompt(card, req, kind) },
    ...req.history.map((h) => ({ role: h.role === 'student' ? ('user' as const) : ('assistant' as const), content: h.text })),
    { role: 'user' as const, content: req.studentText },
  ];

  const t0 = Date.now();
  let firstPhraseMs: number | null = null;
  let provider = '';
  const filter = verdictFilter((delta) => {
    if (firstPhraseMs === null && delta.trim()) firstPhraseMs = Date.now() - t0;
    opts.onDelta?.(delta);
  });
  const result = await hub.run('text', `tutor ${card.id}`, async (text, model, signal): Promise<TextResult> => {
    provider = text.provider;
    const events = text.stream(
      {
        model,
        messages,
        maxTokens: 200,
        context: { kind, language: req.language, studentText: req.studentText, followUp: card.key.followUp, expectedCause: card.key.expectedCause, cardId: card.id },
      },
      { signal: signal ?? opts.signal },
    );
    for await (const ev of events) {
      if (ev.type === 'delta') filter.push(ev.text);
      else return { text: ev.text, model: ev.model, usage: ev.usage };
    }
    throw new EngineError('internal', 'text stream ended without a done event', { modality: 'text' });
  });

  const { text, verdict } = filter.finish(result.text);
  opts.onMeta?.({ verdict, provider, model: result.model, firstPhraseMs, totalMs: Date.now() - t0, kind });
  const hintGiven = countsAsHint(kind, verdict);
  const hintsAfter = req.hintsUsed + (hintGiven ? 1 : 0);
  const next: NextMove = kind === 'explain_please' ? 'direct_explanation' : kind === 'question' ? 'ask_why' : NEXT[verdict ?? 'none'];
  return {
    text,
    evidence: kind === 'answer' ? evidenceOf(verdict, req, hintsAfter) : null,
    next,
    hintGiven,
    model: result.model,
  };
}
