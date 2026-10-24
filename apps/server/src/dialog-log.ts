import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local dialog log for comparing tutor models later: one JSON line per event in
 * `data/logs/tutor-YYYY-MM-DD.jsonl` (git-ignored, files 0600). Only whitelisted fields — never keys, audio
 * or headers. Two event kinds share a `turnId`: `turn` (written when the tutor reply is complete) and
 * `voice` (written when the reply has been spoken). `UNDERSTANDITY_DIALOG_LOG=0` turns it off.
 */
export interface TurnEntry {
  type: 'turn';
  turnId: string;
  at: string;
  courseId: string;
  cardId: string;
  step: string;
  kind: string;
  world: string;
  language: string;
  /** The child's answer as recognised and confirmed (or typed). */
  student: string;
  tutor: string | null;
  verdict: string | null;
  hintGiven: boolean | null;
  next: string | null;
  provider: string | null;
  model: string | null;
  profile: string;
  /** Speech recognition time reported by the web client for this answer. */
  sttMs: number | null;
  /** Time to the first words of the reply the child sees. */
  firstPhraseMs: number | null;
  tutorMs: number | null;
  error: string | null;
}

export interface VoiceEntry {
  type: 'voice';
  turnId: string;
  at: string;
  provider: string | null;
  model: string | null;
  ttsMs: number;
  audioSec: number | null;
  error: string | null;
}

const TURN_ID = /^[0-9a-f-]{36}$/;
export const isTurnId = (v: unknown): v is string => typeof v === 'string' && TURN_ID.test(v);

export class DialogLog {
  constructor(
    readonly dir: string,
    private readonly enabled = true,
  ) {}

  file(now = new Date()): string {
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return join(this.dir, `tutor-${d}.jsonl`);
  }

  write(entry: TurnEntry | VoiceEntry): void {
    if (!this.enabled) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.file(), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      // Logging must never break a lesson.
      console.error('dialog log: write failed', err instanceof Error ? err.message : err);
    }
  }
}
