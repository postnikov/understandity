import { EngineError, type Course, type ResourceDispatcher, type TextAdapter } from '@understandity/contracts';

/**
 * Course generation module. Owner implements `CourseGenerator` with the local text engine
 * (prompt: vault note «Проверка — курс от локальной модели», section «Точный промпт генерации»).
 * Output must parse with `CourseSchema`; every card starts as `draft`/`needs_review` — adult approval is separate.
 */
export interface CourseRequest {
  /** Concept to teach, e.g. "Почему лёд не тонет в воде? Плотность." */
  topic: string;
  language: string;
  ageRange: [number, number];
  /** Worlds to render scenes for: `fantasy`, `anime`, ... */
  worlds: string[];
  cardCount: number;
  /** Verified subject notes the adult supplied; the model must not invent the criterion of correctness. */
  sourceNotes?: string;
}

export interface CourseGenerationDeps {
  text: TextAdapter;
  model: string;
  dispatcher: ResourceDispatcher;
  signal?: AbortSignal;
}

export interface CourseGenerator {
  generate(req: CourseRequest, deps: CourseGenerationDeps): Promise<Course>;
}

export const notImplementedGenerator: CourseGenerator = {
  async generate() {
    throw new EngineError('not_implemented', 'course generation is not implemented yet', { modality: 'text' });
  },
};
