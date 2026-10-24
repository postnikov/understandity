import {
  TutorTurnRequestSchema,
  collectText,
  findCard,
  type Course,
  type NextMove,
  type TutorTurnReply,
  type TutorTurnRequest,
} from '@understandity/contracts';
import { EngineError } from '@understandity/contracts';
import type { EngineHub } from './engines.js';

/**
 * One tutor turn: card goal + key + rubric + recent dialogue → one short question or explanation.
 * Skeleton logic; the text-engine module owner replaces the prompt and the evidence extraction.
 */
export async function tutorTurn(hub: EngineHub, course: Course, input: TutorTurnRequest): Promise<TutorTurnReply> {
  const req = TutorTurnRequestSchema.parse(input);
  const found = findCard(course, req.cardId);
  if (!found) throw new EngineError('bad_input', `unknown card ${req.cardId}`);
  const { card } = found;

  const system = [
    `Ты наставник школьника 12–14 лет. Язык ответа: ${req.language}. Мир ученика: ${req.world}.`,
    `Цель карточки: ${card.fact.statement}`,
    `Ключ (не выдавай заранее): ${card.key.expectedCause}`,
    `Типичная ошибка: ${card.key.typicalMistake}`,
    'Отвечай 2–4 короткими предложениями, ровно один вопрос. Не хвали до проверки причины. Не оценивай акцент и стиль речи.',
    req.hintsUsed >= 2 ? 'Две подсказки уже были: дай прямой разбор на другом примере.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system' as const, content: system },
    ...req.history.map((h) => ({ role: h.role === 'student' ? ('user' as const) : ('assistant' as const), content: h.text })),
    { role: 'user' as const, content: req.studentText },
  ];

  const kind = req.hintsUsed >= 2 ? 'explain_please' : req.kind;
  const result = await hub.run('text', `tutor ${card.id}`, (text, model, signal) =>
    collectText(
      text.stream(
        {
          model,
          messages,
          maxTokens: 160,
          context: { kind, studentText: req.studentText, followUp: card.key.followUp, expectedCause: card.key.expectedCause, cardId: card.id },
        },
        { signal },
      ),
    ),
  );

  const next: NextMove = kind === 'explain_please' ? 'direct_explanation' : kind === 'question' ? 'ask_why' : 'counterexample';
  return { text: result.text, evidence: null, next, hintGiven: kind === 'answer', model: result.model };
}
