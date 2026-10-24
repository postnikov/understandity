import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCourse } from '../src/config.js';
import type { TurnEntry, VoiceEntry } from '../src/dialog-log.js';
import { REVIEW_TASK, buildReview, formatSessions, listSessions, readLogs } from '../src/logs/sessions.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const course = loadCourse();
const card = course.concepts[0]!.cards[0]!;

function turn(over: Partial<TurnEntry>): TurnEntry {
  return {
    type: 'turn', turnId: crypto.randomUUID(), sessionId: A, at: '2026-10-24T13:00:00.000Z', courseId: course.id, cardId: card.id,
    step: 'predict', kind: 'answer', world: 'fantasy', language: 'en', student: 'It sinks.', tutor: 'Why do you think so?',
    verdict: 'partial', hintGiven: true, next: 'stay', provider: 'ollama', model: 'gemma4:12b-mlx', profile: 'offline',
    sttMs: 900, firstPhraseMs: 700, tutorMs: 2100, error: null, ...over,
  };
}

function writeLog(entries: (TurnEntry | VoiceEntry | Record<string, unknown>)[], extra = '') {
  const dir = mkdtempSync(join(tmpdir(), 'ud-logs-'));
  writeFileSync(join(dir, 'tutor-2026-10-24.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra);
  writeFileSync(join(dir, 'notes.txt'), 'not a log');
  return dir;
}

describe('session logs: list and review', () => {
  const t1 = turn({});
  const t2 = turn({ at: '2026-10-24T13:01:00.000Z', step: 'explain', verdict: 'correct', student: 'Density, not weight.' });
  const t3 = turn({ sessionId: B, at: '2026-10-24T14:00:00.000Z', provider: 'anthropic', model: 'claude-sonnet-5-5', profile: 'online' });
  const legacy = { ...turn({}), sessionId: undefined };
  const voice: VoiceEntry = { type: 'voice', turnId: t1.turnId, sessionId: A, at: t1.at, provider: 'by-language', model: 'kokoro', ttsMs: 300, audioSec: 2.1, error: null };

  it('groups turns by session with course, turn count and model; counts lines without a session', () => {
    const log = readLogs(writeLog([t1, voice, t2, t3, legacy], '{broken\n'));
    expect(log.badLines).toBe(1);
    expect(log.withoutSession).toBe(1);
    const list = listSessions(log.entries);
    expect(list.map((s) => [s.sessionId, s.turns, s.models, s.profiles])).toEqual([
      [A, 2, ['ollama/gemma4:12b-mlx'], ['offline']],
      [B, 1, ['anthropic/claude-sonnet-5-5'], ['online']],
    ]);
    const text = formatSessions(list, log.withoutSession);
    expect(text).toContain(A);
    expect(text).toContain('1 turn line(s) without a session id');
  });

  it('an empty or missing log directory lists nothing', () => {
    expect(formatSessions(listSessions(readLogs(join(tmpdir(), 'no-such-ud-dir')).entries))).toBe('No sessions in the log yet.');
  });

  it('review: dialog by card and step with verdicts, the task and the current tutor prompt; only that session', () => {
    const md = buildReview([t1, voice, t2, t3], A, { courses: new Map([[course.id, course]]), generatedAt: new Date('2026-10-24T15:00:00Z') });
    expect(md).toContain(`# Tutor session review`);
    expect(md).toContain(`### Card \`${card.id}\` — ${card.title}`);
    expect(md).toContain(card.key.expectedCause);
    expect(md).toContain('#### Step: predict');
    expect(md).toContain('#### Step: explain');
    expect(md).toContain('**Turn 1** · answer · verdict **partial**');
    expect(md).toContain('«Density, not weight.»');
    expect(md).toContain('> Why do you think so?');
    expect(md).toContain('voice 0.3 s');
    expect(md).toContain(REVIEW_TASK);
    expect(md).toContain('## Current tutor prompt');
    expect(md).toContain('VERDICT');
    expect(md).not.toContain('claude-sonnet-5-5');
  });

  it('review of an unknown session fails loudly', () => {
    expect(() => buildReview([t1], B)).toThrow(/not found/);
  });
});
