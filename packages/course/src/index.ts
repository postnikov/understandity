/**
 * Course generation module: the local text engine drafts a course from adult-verified notes
 * (prompt: vault note «Проверка — курс от локальной модели»). Output parses with `CourseSchema`;
 * every card starts as `needs_review` — adult approval is separate (`/api/courses/:id/review`).
 */
export * from './types.js';
export { buildPrompt, buildRepairPrompt, languageName, WORLD_HINTS, worldsInstruction } from './prompt.js';
export {
  DraftCardSchema,
  DraftCourseSchema,
  draftToCourse,
  extractJson,
  generateCourse,
  localCourseGenerator,
  parseDraft,
  slugify,
  softChecks,
  words,
  type DraftCard,
  type DraftCourse,
} from './generator.js';
export {
  applyReview,
  courseSummary,
  markRevised,
  reviseCard,
  showableCourse,
  syncCourseReview,
  ReviewRequestSchema,
  type CardPatch,
  type CourseSummary,
  type ReviewRequest,
  type RevisionResult,
} from './review.js';
export { addWorlds, buildWorldsPrompt, mergeWorlds, parseWorlds, WorldsDraftSchema } from './worlds.js';
export { buildImagePrompts, withoutNumbers, type ImagePromptEntry, type MediaStyles } from './media.js';
