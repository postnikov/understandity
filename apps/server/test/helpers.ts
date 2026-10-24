import { resolve } from 'node:path';
import { CourseSchema, type Course } from '@understandity/contracts';
import { loadCourse, loadEnginesConfig } from '../src/config.js';

/** Fixture path of a course nobody approved — independent of what an adult clicks in the live gate. */
export const DRAFT_COURSE_FILE = resolve(import.meta.dirname, 'fixtures/draft-course.json');

/** The unreviewed demo course as a fixture (`needs_review` everywhere), not the live `content/` file. */
export function draftCourse(): Course {
  const course: Course = loadCourse(DRAFT_COURSE_FILE);
  CourseSchema.parse(course);
  return course;
}

/** `config/engines.json` with every modality switched to its fake provider: tests never touch real models. */
export function fakeEnginesConfig() {
  const config = loadEnginesConfig();
  for (const m of ['text', 'stt', 'tts', 'image'] as const) {
    const fake = config.providers[m].fake!;
    config.defaults.engines[m] = { provider: 'fake', model: fake.models[0]!, voice: fake.voices[0] ?? null };
  }
  config.defaults.language = 'ru';
  return config;
}
