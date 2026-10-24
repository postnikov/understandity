/**
 * Course generation module: the local text engine drafts a course from adult-verified notes
 * (prompt: vault note «Проверка — курс от локальной модели»). Output parses with `CourseSchema`;
 * every card starts as `needs_review` — adult approval is separate (`/api/courses/:id/review`).
 */
export * from './types.js';
export { buildPrompt, buildRepairPrompt, languageName } from './prompt.js';
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
export { applyReview, courseSummary, showableCourse, ReviewRequestSchema, type CourseSummary, type ReviewRequest } from './review.js';
