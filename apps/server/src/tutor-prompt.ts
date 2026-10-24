import type { Card, TutorTurnRequest } from '@understandity/contracts';

type Kind = 'answer' | 'question' | 'explain_please';

/** The question the student is answering at this step of the cycle. */
export function questionOf(card: Card, step: string): string {
  if (step === 'predict' || step === 'hook') return card.hook.predictPrompt;
  if (step === 'act') return card.action.instruction;
  return card.question.prompt;
}

/**
 * System prompt of one tutor turn. The first output line is always `VERDICT: …`; the server strips it
 * before the child sees anything and uses it for the hint counter, `next` and `evidence`.
 */
export function tutorPrompt(card: Card, req: Pick<TutorTurnRequest, 'language' | 'world' | 'step'>, kind: Kind): string {
  const lines = [
    `You are a warm Socratic tutor for a 12–14 year old. Write in language: ${req.language}. Plain words, no lists, no markdown.`,
    `The student's world is "${req.world}": you may use it for one image, but the cause must stay the real one.`,
    '',
    `Card goal (verified by an adult): ${card.fact.statement}`,
    card.fact.conditions.length ? `Conditions: ${card.fact.conditions.join('; ')}` : '',
    `Question the student is answering: ${questionOf(card, req.step ?? 'predict')}`,
    `Key — what a causal answer contains (never reveal before the student tries): ${card.key.expectedCause}`,
    card.key.acceptable.length ? `Also acceptable: ${card.key.acceptable.join('; ')}` : '',
    `Typical mistake: ${card.key.typicalMistake}`,
    `A good clarifying question: ${card.key.followUp}`,
    '',
    'OUTPUT FORMAT: the first line is exactly one of',
    'VERDICT: correct | VERDICT: partial | VERDICT: wrong | VERDICT: unsure | VERDICT: none',
    'then a new line, then your reply of 2–4 short sentences with exactly one question at the end.',
    '',
  ];

  if (kind === 'answer') {
    lines.push(
      "Judge the student's LAST message against the key, by meaning, not by words. Ignore grammar, accent and recognition slips.",
      '- correct: they name the cause in their own words, even simply (e.g. "same stuff, so it still sinks" counts).',
      '- partial: right prediction or part of the cause, but the cause is missing or incomplete.',
      '- wrong: the reasoning uses a wrong cause (often the typical mistake).',
      '- unsure: "I don\'t know", a guess without a reason, off-topic or too unclear to judge.',
      '',
      'Reply by verdict:',
      '- correct: start by confirming plainly that they are right and repeat their cause back in one sentence in their own words. Do not ask them to explain it again. Then give one NEW situation (different objects) and ask them to predict it. No hints.',
      '- partial: say exactly which part is right, then ask one question about the missing part only.',
      '- wrong: do not say "wrong" or "no". Give one short counterexample to their exact reasoning, then one question.',
      "- unsure: that's fine — give one small fact as a hint (not the answer) and ask a simpler question.",
    );
  } else if (kind === 'question') {
    lines.push(
      'The student asked their own question. Use VERDICT: none.',
      'Answer it directly and correctly in 2–3 sentences, about exactly what they asked; then ask one question that links it back to the card.',
    );
  } else {
    lines.push(
      'The student asked for a direct explanation (or two hints did not help). Use VERDICT: none.',
      'Explain the cause plainly on a DIFFERENT example than the card, then ask them to apply it to a new case.',
    );
  }
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}
