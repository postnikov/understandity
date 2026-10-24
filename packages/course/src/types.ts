import type { Course, ResourceDispatcher, TextAdapter, TextResult } from '@understandity/contracts';

export interface CourseRequest {
  /** Concept to teach, e.g. "Do heavy things always sink? Density and floating." */
  topic: string;
  language: string;
  ageRange: [number, number];
  /** Worlds to render scenes for: `fantasy`, `anime`, ... */
  worlds: string[];
  cardCount: number;
  /** Verified subject notes the adult supplied; the model must not invent the criterion of correctness. */
  sourceNotes?: string;
  /** Where an adult verifies the facts (OpenStax section). Copied into every card, never written by the model. */
  source?: { label: string; url: string | null };
  /** Course id / file slug; derived from the title when absent. */
  id?: string;
  subject?: string;
  /** `child` (default, 12–14) or `adult`: decides the voice of every learner-facing string. */
  audience?: 'child' | 'adult';
  /**
   * The learner's own words: what they do not understand. Set for on-request courses — there are no
   * adult notes, the model draws facts from its own knowledge and the course says so in `fact.source`.
   */
  request?: string;
  /** Overrides the course `origin` (on-request courses record the request and the engine). */
  origin?: { generator: 'on-request'; request: string; engine: 'local' | 'online'; audience: 'child' | 'adult' };
}

/** Coarse progress of one generation, for the UI. */
export type GenerationStep = 'outline' | 'cards' | 'worlds' | 'saving';

export interface CourseGenerationDeps {
  text: TextAdapter;
  model: string;
  dispatcher: ResourceDispatcher;
  signal?: AbortSignal;
  /** Generation budget; the whole course is one request. */
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Called when the generation moves to the next coarse step. */
  onStep?: (step: GenerationStep) => void;
}

export interface GenerationAttempt {
  ms: number;
  usage?: TextResult['usage'];
  problems: string[];
}

export interface GenerationReport {
  model: string;
  provider: string;
  totalMs: number;
  attempts: GenerationAttempt[];
  /** Soft acceptance findings copied into card review notes. */
  warnings: string[];
}

export interface CourseGenerator {
  generate(req: CourseRequest, deps: CourseGenerationDeps): Promise<Course>;
}
