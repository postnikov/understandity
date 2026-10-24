/**
 * Generation prompt. Source: vault note «Проверка — курс от локальной модели», sections
 * «Точный промпт генерации» (base prompt, translated, output switched from Markdown to JSON)
 * and «Что держать в промпте и в приёмке» (the added block: one causal link, conditions,
 * "may" ≠ "must", one changed condition, key answers exactly its own question, flag doubts, safe actions).
 * Differences from the note on purpose: the adult supplies verified source notes (the note showed the model
 * must not invent both the content and its criterion of correctness), and the output is JSON for the schema.
 */
import type { CourseRequest } from './types.js';

const LANG_NAMES: Record<string, string> = { en: 'English', ru: 'Russian', es: 'Spanish', ca: 'Catalan' };

export function languageName(lang: string): string {
  return LANG_NAMES[lang.toLowerCase().split('-')[0] ?? ''] ?? lang;
}

/** One world scene. Shared by course generation and by adding worlds to an existing course. */
export const WORLD_SCENE_SHAPE =
  '{ "world": "<world id>", "scene": "short version of the scene in this world; heroes and look change, cause, conditions and the right answer stay", "illustration": "simple scheme for an illustration, no text in the picture" }';

/** What a world id means for the model. Unknown ids are passed as is. */
export const WORLD_HINTS: Record<string, string> = {
  fantasy: 'fantasy: wizards, dragons, castles, magic',
  anime: 'anime: a young hero, school or adventure, bright and expressive',
  space:
    'space: sci-fi about space — astronauts, spaceships, stations, other planets; scenes with water, weight or plants happen where gravity and air work as on Earth (on a planet, inside a station with artificial gravity) unless the card says otherwise',
  cyberpunk: 'cyberpunk: a neon megacity at night, hackers, robots, drones, implants',
};

export function worldsInstruction(worlds: string[]): string {
  const hints = worlds.map((w) => WORLD_HINTS[w.toLowerCase()] ?? w);
  return `Worlds: give exactly one scene for each of these worlds: ${hints.join('; ')}. Use the world id before the colon as "world". Knowing a specific series is not required.`;
}

/** JSON shape the model fills. Ids, review status, sources and rubric moves are added by code. */
export const DRAFT_SHAPE = `{
  "title": "course title, a short surprising question",
  "outcome": "one line: what the student will be able to explain",
  "centralCause": "the ONE central causal relation of the course and where it applies",
  "conditions": ["condition without which the central claim is wrong"],
  "cards": [
    {
      "title": "concept of this card",
      "fact": { "statement": "the causal claim of this card in plain words", "conditions": ["..."] },
      "hook": { "question": "surprising but true question; do not reveal the answer", "predictPrompt": "invitation to predict the result WITH a reason, answered by voice" },
      "explanation": "40-60 words: how it works; explain a term before using it; metaphor separated from mechanism; name the conditions",
      "action": { "instruction": "one safe thought experiment or action with everyday room-temperature objects; change exactly one condition; predict first, then compare two results", "changedCondition": "the one condition that changes", "constants": ["conditions kept the same"] },
      "worlds": [ ${WORLD_SCENE_SHAPE} ],
      "voiceQuestion": "ONE question about a NEW neutral situation that needs a prediction and a cause; answered in own words in 15-30 seconds; no writing, formulas or multiple choice; not a request to repeat a term",
      "key": { "expectedCause": "what a causal answer to THIS voiceQuestion must contain", "acceptable": ["acceptable refinement of conditions"], "typicalMistake": "typical wrong reasoning", "followUp": "one clarifying question for the tutor" },
      "rubric": { "showsCause": "example answer that shows the cause", "wrongUse": "example: familiar words used wrongly", "notEnough": "example: not enough yet" },
      "askTutor": "one natural question the child might ask the tutor about this card",
      "needsAdultCheck": false,
      "doubt": null
    }
  ]
}`;

export function buildPrompt(req: CourseRequest): { system: string; user: string } {
  const lang = languageName(req.language);
  const [ageFrom, ageTo] = req.ageRange;
  const system = [
    `You write a micro-course for a school student aged ${ageFrom}-${ageTo}. Write every learner-facing string in ${lang}.`,
    'Return ONLY one JSON object, no Markdown, no comments, no reasoning.',
  ].join(' ');

  const user = `Topic: ${req.topic}

Goal: the student understands the cause, predicts the result of changing a condition and transfers the principle to a new situation. This is not a course about AI. Do not make the student memorise definitions.

${
  req.sourceNotes
    ? `Verified subject notes from an adult (the ONLY source of facts; do not add facts that contradict or go beyond them; if something important is missing, set "needsAdultCheck": true and explain in "doubt"):
<<<NOTES
${req.sourceNotes.trim()}
NOTES>>>`
    : 'No verified notes were given: mark every card "needsAdultCheck": true.'
}

Create exactly ${req.cardCount} connected cards, from the first observation to application. One card = one concept or one causal link.

First define ONE central causal relation of the course and list the conditions where it applies. If conditions are missing, do not invent a single definite outcome. Never turn "may" into "always" in a question or key. In a thought experiment change exactly one condition and name the others as constant. Check that the title and the worlds do not contradict the explanation and do not turn a metaphor into the mechanism.

${worldsInstruction(req.worlds)}

The key belongs to the card and answers exactly that card's voiceQuestion: the causal answer to it, an acceptable refinement of conditions and an example of wrong reasoning. Do not reveal the key to the child in advance. If you doubt a fact or a key, set "needsAdultCheck": true and write the doubt; do not guess. Actions are only thought experiments or actions with ordinary room-temperature objects: no fire, freezer, hot surfaces, tasting substances, complex equipment, or depriving a living plant or animal of vital conditions in practice.

For a spoken answer the tutor judges the cause and the prediction, not matching words. Do not draw medical conclusions from a school experiment. Do not invent sources, experiment results or numerical measurements; call your own thought experiment a thought experiment. Each card is 130-190 words in total.

JSON shape (fill every field):
${DRAFT_SHAPE}`;

  return { system, user };
}

export function buildRepairPrompt(previous: string, problems: string[]): string {
  return `Your JSON did not pass validation:
${problems.map((p) => `- ${p}`).join('\n')}

Return the corrected full JSON object only, same shape, fix exactly these problems and keep the rest.
Previous output:
${previous.slice(0, 24_000)}`;
}
