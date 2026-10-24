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

/** Measured numbers ("0.8 g/cm3", "3x3") are drawn as text by image models: drop the comma-clause that carries them. */
export function withoutNumbers(text: string): string {
  const clauses = text.split(',');
  const kept = clauses.filter((c, i) => i === 0 || !/\d/.test(c));
  return kept
    .join(',')
    .replace(/\d+(?:[.,]\d+)?\s*(?:x\s*\d+|g\/cm3|g\/cm³|cm3|cm³|kg|g|m)?/gi, '')
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
