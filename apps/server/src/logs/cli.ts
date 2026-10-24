import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../config.js';
import { defaultContentDir, scanCourses } from '../routes/course.js';
import { buildReview, formatSessions, listSessions, readLogs } from './sessions.js';

/**
 * `npm run logs:sessions` — the learning sessions in the local dialog log.
 * `npm run logs:review -- --session <id>` — one session as a markdown review for a strong model, into `data/reviews/`.
 */
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { session: { type: 'string' }, out: { type: 'string' } } });
const logDir = process.env.UNDERSTANDITY_LOG_DIR ?? resolve(REPO_ROOT, 'data/logs');
const log = readLogs(logDir);

if (command === 'sessions') {
  console.log(formatSessions(listSessions(log.entries), log.withoutSession));
} else if (command === 'review') {
  const wanted = values.session?.trim();
  if (!wanted) {
    console.error('usage: npm run logs:review -- --session <id>   (ids: npm run logs:sessions)');
    process.exit(2);
  }
  // A unique prefix is enough, like a short git hash.
  const ids = listSessions(log.entries).map((s) => s.sessionId).filter((id) => id.startsWith(wanted));
  if (ids.length !== 1) {
    console.error(ids.length ? `session prefix ${wanted} matches ${ids.length} sessions` : `session ${wanted} not found in ${logDir}`);
    process.exit(1);
  }
  const sessionId = ids[0]!;
  const courses = new Map([...(await scanCourses(defaultContentDir())).entries()].map(([id, c]) => [id, c.course]));
  const md = buildReview(log.entries, sessionId, { courses });
  const dir = resolve(REPO_ROOT, 'data/reviews');
  const out = values.out ? resolve(values.out) : join(dir, `session-${sessionId.slice(0, 8)}.md`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(out, md, { encoding: 'utf8', mode: 0o600 });
  console.log(`review written: ${relative(process.cwd(), out)}`);
} else {
  console.error('usage: logs sessions | logs review --session <id>');
  process.exit(2);
}
