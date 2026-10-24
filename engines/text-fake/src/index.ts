import {
  TextRequestSchema,
  type AdapterFactory,
  type ProviderModule,
  type TextAdapter,
  type TextStreamEvent,
} from '@understandity/contracts';

/**
 * Plausible tutor without a model. Reads `context.kind` / `context.studentText` / `context.followUp`
 * the server puts into the request and answers with one short Socratic question.
 */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

function pickReply(ctx: Record<string, unknown>): string {
  const kind = String(ctx.kind ?? 'answer');
  const said = String(ctx.studentText ?? '').toLowerCase();
  const followUp = typeof ctx.followUp === 'string' ? ctx.followUp : 'А что при этом произошло с объёмом?';
  const expected = typeof ctx.expectedCause === 'string' ? ctx.expectedCause : '';
  if (kind === 'explain_please') {
    return `Хорошо, коротко: ${expected || 'важна не масса сама по себе, а масса на единицу объёма — плотность.'} Попробуешь применить это к новой задаче?`;
  }
  if (kind === 'question') {
    return 'Хороший вопрос. Корабль железный, но внутри у него много воздуха: считаем плотность всего корпуса вместе с воздухом. Как думаешь, что будет, если корпус пробить?';
  }
  if (/плотност|на один кубик|на единицу объ|отношени/.test(said)) {
    return 'Ты назвал причину — сравнил массу и объём. Теперь новая ситуация без подсказки: что будет с куском пластилина, если раскатать его в тонкую лодочку?';
  }
  if (/легче|тяжел|тяжёл|масс/.test(said)) {
    return `Ты заметил массу. ${followUp}`;
  }
  return 'Я услышал не всё. Скажи ещё раз: что произойдёт и почему?';
}

export const createFakeText: AdapterFactory<'text'> = (config, { providerId }): TextAdapter => ({
  modality: 'text',
  provider: providerId,
  locality: config.locality,
  heavy: false,
  async health() {
    return { state: 'ok', detail: 'fake tutor, no model loaded', loadedModel: null, checkedAt: new Date().toISOString() };
  },
  async listModels() {
    return config.models.map((id) => ({ id, label: 'Fake tutor', installed: true, languages: ['ru', 'en'] }));
  },
  capabilities() {
    return { streaming: true, audioInput: false, maxContextTokens: 2048, languages: ['ru', 'en'] };
  },
  async *stream(input, opts): AsyncIterable<TextStreamEvent> {
    const req = TextRequestSchema.parse(input);
    const text = pickReply(req.context ?? {});
    let acc = '';
    for (const word of text.split(/(?<= )/)) {
      if (opts?.signal?.aborted) break;
      await sleep(8, opts?.signal);
      acc += word;
      yield { type: 'delta', text: word };
    }
    yield { type: 'done', text: acc, model: req.model, usage: { outputTokens: acc.split(/\s+/).length, totalMs: 0 } };
  },
});

export const textFake: ProviderModule<'text'> = { modality: 'text', providerId: 'fake', create: createFakeText };
