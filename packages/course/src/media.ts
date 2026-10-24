import type { Course } from '@understandity/contracts';

/** Entry of `content/media/prompts.json` — the format the illustration step (designer / image engine) reads. */
export interface ImagePromptEntry {
  course: string;
  card: string;
  world: string;
  seed: number;
  preset: string;
  image: string;
  prompt: string;
}

export interface MediaStyles {
  preset: string;
  noText: string;
  worlds: Record<string, string>;
  courses: Record<string, string>;
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n: string) => WORDS[Number(n)] ?? n;
const MEASURE = /\d+(?:[.,]\d+)?\s*(?:g\/cm3|g\/cm³|cm3|cm³|kg|g|m)\b/i;

/**
 * Image models draw digits as text. A comma-clause with a measured value ("0.8 g/cm3", "400 g") is dropped,
 * small counts become words ("3x3" → "three-by-three", "3 times" → "three times").
 */
export function withoutNumbers(text: string): string {
  const clauses = text.split(',');
  const kept = clauses.filter((c, i) => i === 0 || !MEASURE.test(c));
  return kept
    .join(',')
    .replace(new RegExp(MEASURE.source, 'gi'), '')
    .replace(/\b(\d+)\s*[x×]\s*(\d+)\b/g, (_, a: string, b: string) => `${word(a)}-by-${word(b)}`)
    .replace(/\b(\d+)\b/g, (_, a: string) => word(a))
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** One prompt per card × world: setting (hero, place) + what is visible + course camera + world style + no-text block. */
export function buildImagePrompts(course: Course, worlds: string[], styles: MediaStyles, startSeed: number): ImagePromptEntry[] {
  const out: ImagePromptEntry[] = [];
  let seed = startSeed;
  for (const card of course.concepts.flatMap((k) => k.cards)) {
    for (const world of worlds) {
      const scene = card.worlds.find((w) => w.world === world);
      const style = styles.worlds[world];
      if (!scene) throw new Error(`card ${card.id} has no ${world} scene`);
      if (!style) throw new Error(`no style block for world "${world}" in styles`);
      const parts = [sentence(withoutNumbers(scene.scene)), sentence(withoutNumbers(scene.illustration)), styles.courses[course.id], style, styles.noText].filter(
        Boolean,
      ) as string[];
      out.push({
        course: course.id,
        card: card.id,
        world,
        seed: seed++,
        preset: styles.preset,
        image: `/media/${course.id}/${card.id}-${world}.png`,
        prompt: parts.join(' '),
      });
    }
  }
  return out;
}
