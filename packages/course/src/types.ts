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
}

export interface CourseGenerationDeps {
  text: TextAdapter;
  model: string;
  dispatcher: ResourceDispatcher;
  signal?: AbortSignal;
  /** Generation budget; the whole course is one request. */
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
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
