/**
 * npm run course:worlds -- --course content/heavy-things-sink.json --worlds space,cyberpunk
 *   [--provider ollama] [--model gemma4:12b-mlx] [--prompts content/media/prompts.json] [--styles content/media/styles.json] [--unload] [--force]
 *
 * The local model writes scenes of new worlds for every card (same world rules as course generation).
 * Approval stays (cause, conditions, answer are unchanged), the addition goes to `review.notes`.
 * Illustration prompts for the new frames are appended to prompts.json; `worlds[].image` stays null until rendered.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CourseSchema, EnginesConfigSchema, type ProviderModule } from '@understandity/contracts';
import { createDispatcher } from '@understandity/dispatcher';
import { textOllama } from '@understandity/engine-text-ollama';
import { buildImagePrompts, type ImagePromptEntry, type MediaStyles } from './media.js';
import { addWorlds } from './worlds.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PROVIDERS: Record<string, ProviderModule<'text'>> = { ollama: textOllama };

const writeJson = (path: string, data: unknown) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
};

async function main() {
  const { values } = parseArgs({
    options: {
      course: { type: 'string' },
      worlds: { type: 'string', default: 'space,cyberpunk' },
      provider: { type: 'string', default: 'ollama' },
      model: { type: 'string' },
      prompts: { type: 'string', default: resolve(REPO_ROOT, 'content/media/prompts.json') },
      styles: { type: 'string', default: resolve(REPO_ROOT, 'content/media/styles.json') },
      config: { type: 'string' },
      unload: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });
  if (!values.course) throw new Error('--course is required');
  const worlds = values.worlds!.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  const coursePath = resolve(values.course);
  const course = CourseSchema.parse(JSON.parse(readFileSync(coursePath, 'utf8')));
  const styles = JSON.parse(readFileSync(values.styles!, 'utf8')) as MediaStyles;
  for (const w of worlds) if (!styles.worlds[w]) throw new Error(`no style block for world "${w}" in ${values.styles}`);

  const config = EnginesConfigSchema.parse(
    JSON.parse(readFileSync(values.config ?? process.env.UNDERSTANDITY_ENGINES ?? resolve(REPO_ROOT, 'config/engines.json'), 'utf8')),
  );
  const providerConfig = config.providers.text[values.provider!];
  const mod = PROVIDERS[values.provider!];
  if (!providerConfig || !mod || !providerConfig.enabled) throw new Error(`text provider "${values.provider}" is not available`);
  const model = values.model ?? providerConfig.models[0]!;
  const text = mod.create(providerConfig, { providerId: values.provider! });
  const health = await text.health();
  if (health.state === 'down') throw new Error(`${values.provider} is down: ${health.detail}`);
  if (text.heavy && health.loadedModel && health.loadedModel !== model && !values.force) {
    throw new Error(`another model is resident (${health.loadedModel}); heavy models run one at a time — wait or pass --force`);
  }

  console.error(`adding worlds ${worlds.join(', ')} to ${course.id} with ${values.provider}:${model} …`);
  const opt = providerConfig.options;
  const res = await addWorlds(course, worlds, {
    text,
    model,
    dispatcher: createDispatcher(),
    maxTokens: typeof opt.courseNumPredict === 'number' ? opt.courseNumPredict : undefined,
    timeoutMs: typeof opt.courseTimeoutMs === 'number' ? opt.courseTimeoutMs : undefined,
  });

  const existing = JSON.parse(readFileSync(values.prompts!, 'utf8')) as ImagePromptEntry[];
  const kept = existing.filter((e) => !(e.course === course.id && worlds.includes(e.world)));
  const startSeed = Math.max(100, ...kept.map((e) => e.seed)) + 1;
  const fresh = buildImagePrompts(res.course, worlds, styles, startSeed);

  writeJson(coursePath, res.course);
  writeJson(values.prompts!, [...kept, ...fresh]);
  if (values.unload) await text.unload?.(model);

  console.log(
    JSON.stringify(
      {
        course: course.id,
        worlds,
        totalSec: +(res.totalMs / 1000).toFixed(2),
        attempts: res.attempts.map((a) => ({ sec: +(a.ms / 1000).toFixed(2), outTokens: a.usage?.outputTokens, problems: a.problems })),
        prompts: fresh.length,
        seeds: [fresh[0]?.seed, fresh.at(-1)?.seed],
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
