/**
 * npm run course:generate -- --concept "…" --source content/sources/x.md --lang en --out content/x.json
 *   [--provider ollama] [--model gemma4:12b-mlx] [--cards 5] [--worlds fantasy,anime] [--age 12-14]
 *   [--id x] [--subject physics] [--unload] [--force]
 *
 * Source file: Markdown with optional front matter `source:` (label), `url:`, `subject:`; the body is the
 * adult-verified subject notes. The result is written with every card `needs_review`.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EnginesConfigSchema, type ProviderModule } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { textOllama } from '@understandity/engine-text-ollama';
import { textAnthropic } from '../../../engines/text-anthropic/src/index.js';
import { generateCourse } from './generator.js';
import { slugify } from './generator.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PROVIDERS: Record<string, ProviderModule<'text'>> = { ollama: textOllama, anthropic: textAnthropic };

function parseSource(path: string): { notes: string; label: string | null; url: string | null; subject: string | null } {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  if (m) for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '');
  }
  return { notes: (m ? m[2]! : raw).trim(), label: meta.source ?? null, url: meta.url ?? null, subject: meta.subject ?? null };
}

async function main() {
  const { values } = parseArgs({
    options: {
      concept: { type: 'string' },
      source: { type: 'string' },
      lang: { type: 'string', default: 'en' },
      out: { type: 'string' },
      provider: { type: 'string', default: 'ollama' },
      model: { type: 'string' },
      cards: { type: 'string', default: '5' },
      worlds: { type: 'string', default: 'fantasy,anime' },
      age: { type: 'string', default: '12-14' },
      id: { type: 'string' },
      subject: { type: 'string' },
      config: { type: 'string' },
      unload: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.concept) throw new Error('--concept is required');

  const config = EnginesConfigSchema.parse(
    JSON.parse(readFileSync(values.config ?? process.env.UNDERSTANDITY_ENGINES ?? resolve(REPO_ROOT, 'config/engines.json'), 'utf8')),
  );
  const providerConfig = config.providers.text[values.provider!];
  const mod = PROVIDERS[values.provider!];
  if (!providerConfig || !mod) throw new Error(`text provider "${values.provider}" is not configured or has no adapter in the CLI`);
  // Cloud providers stay disabled in config (the offline demo refuses enabled cloud); the CLI may use one when its key is set.
  const cloudWithKey = providerConfig.locality === 'cloud' && !!providerConfig.secretEnv && !!process.env[providerConfig.secretEnv];
  if (!providerConfig.enabled && !cloudWithKey) throw new Error(`text provider "${values.provider}" is disabled in config and has no key`);
  const model = values.model ?? providerConfig.models[0]!;
  const text = mod.create(providerConfig, { providerId: values.provider! });
  const opt = providerConfig.options;

  const health = await text.health();
  if (health.state === 'down') throw new Error(`${values.provider} is down: ${health.detail}`);
  if (text.heavy && health.loadedModel && health.loadedModel !== model && !values.force) {
    throw new Error(`another model is resident (${health.loadedModel}); heavy models run one at a time — wait or pass --force`);
  }

  const src = values.source ? parseSource(resolve(values.source)) : null;
  const [a, b] = values.age!.split('-').map(Number);
  const out = resolve(values.out ?? `content/${values.id ?? slugify(values.concept)}.json`);
  const id = values.id ?? (values.out ? slugify(out.split('/').pop()!.replace(/\.json$/, '')) : undefined);

  console.error(`generating with ${values.provider}:${model} · ${values.cards} cards · ${values.lang} …`);
  const { course, report } = await generateCourse(
    {
      topic: values.concept,
      language: values.lang!,
      ageRange: [a ?? 12, b ?? 14],
      worlds: values.worlds!.split(',').map((w) => w.trim()).filter(Boolean),
      cardCount: Number(values.cards),
      sourceNotes: src?.notes,
      source: src?.label ? { label: src.label, url: src.url } : undefined,
      id,
      subject: values.subject ?? src?.subject ?? undefined,
    },
    {
      text,
      model,
      dispatcher: createDispatcher(),
      maxTokens: typeof opt.courseNumPredict === 'number' ? opt.courseNumPredict : typeof opt.courseMaxTokens === 'number' ? opt.courseMaxTokens : undefined,
      timeoutMs: typeof opt.courseTimeoutMs === 'number' ? opt.courseTimeoutMs : undefined,
    },
  );

  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(course, null, 2)}\n`, 'utf8');
  renameSync(tmp, out);
  if (values.unload) await text.unload?.(model);

  console.log(
    JSON.stringify(
      {
        out,
        id: course.id,
        title: course.title,
        cards: course.concepts.reduce((n, k) => n + k.cards.length, 0),
        totalSec: +(report.totalMs / 1000).toFixed(2),
        attempts: report.attempts.map((x) => ({
          sec: +(x.ms / 1000).toFixed(2),
          outTokens: x.usage?.outputTokens,
          loadSec: x.usage?.loadMs ? +(x.usage.loadMs / 1000).toFixed(2) : undefined,
          problems: x.problems,
        })),
        warnings: report.warnings,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
