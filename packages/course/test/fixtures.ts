import type { TextAdapter, TextRequest, TextStreamEvent } from '@understandity/contracts';
import type { DraftCourse } from '../src/index.js';

export function draftCard(i: number, worlds = ['fantasy', 'anime']) {
  return {
    title: `Density card ${i}`,
    fact: { statement: 'A uniform body sinks when its density is greater than the density of water.', conditions: ['uniform body', 'fresh water'] },
    hook: { question: 'A big wooden block floats but a small stone sinks. How can the lighter thing sink?', predictPrompt: 'Say what happens to each and why.' },
    explanation:
      'Water pushes a body up with a force equal to the weight of the water it pushes aside. Compare the body with water of the same volume. If the same volume of the body is heavier than water, it sinks; if lighter, it floats. Mass per unit volume is called density, and it decides.',
    action: { instruction: 'Thought experiment: cut a sinking plasticine ball in half. Predict first, then compare both halves.', changedCondition: 'size of the piece', constants: ['material', 'water'] },
    worlds: worlds.map((w) => ({ world: w, scene: `A hero in the ${w} world sends cargo across a lake.`, illustration: 'block and stone next to equal volumes of water' })),
    voiceQuestion: 'A 400 g object has a volume of 500 cm3. Will it float in water? Explain how you decided.',
    key: { expectedCause: 'Compares mass with the same volume of water: 0.8 g/cm3 is less than water, so it floats.', acceptable: ['if the object is hollow…'], typicalMistake: 'It is heavy, so it sinks.', followUp: 'What would the same volume of water weigh?' },
    rubric: { showsCause: 'It is lighter than the same amount of water.', wrongUse: 'Density is mass over volume, so small things float.', notEnough: 'It floats because it floats.' },
    askTutor: 'Why does a steel ship float?',
    needsAdultCheck: false,
    doubt: null,
  };
}

export function draftCourse(cards = 3): DraftCourse {
  return {
    title: 'Do heavy things always sink?',
    outcome: 'I can explain why some bodies float and predict what changes when size or shape changes.',
    centralCause: 'A uniform body floats when its density is less than the density of water.',
    conditions: ['uniform body', 'fresh water'],
    cards: Array.from({ length: cards }, (_, i) => draftCard(i + 1)),
  };
}

/** Scripted text engine: returns the given outputs in order and records the requests. */
export function scriptedText(outputs: string[], heavy = false): TextAdapter & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  let n = 0;
  return {
    modality: 'text',
    provider: 'fake',
    locality: 'local',
    heavy,
    requests,
    async health() {
      return { state: 'ok', checkedAt: new Date().toISOString() };
    },
    async listModels() {
      return [{ id: 'fake-tutor', installed: true }];
    },
    capabilities() {
      return { streaming: true, audioInput: false, maxContextTokens: 8192, languages: ['en'] };
    },
    async *stream(req): AsyncIterable<TextStreamEvent> {
      requests.push(req);
      const text = outputs[Math.min(n++, outputs.length - 1)]!;
      yield { type: 'delta', text };
      yield { type: 'done', text, model: req.model, usage: { outputTokens: 100, totalMs: 1 } };
    },
  };
}
