import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CourseSchema, EnginesConfigSchema, type Course, type EnginesConfig } from '@understandity/contracts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadEnginesConfig(path = process.env.UNDERSTANDITY_ENGINES ?? resolve(REPO_ROOT, 'config/engines.json')): EnginesConfig {
  return EnginesConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadCourse(path = process.env.UNDERSTANDITY_COURSE ?? resolve(REPO_ROOT, 'content/demo-course.json')): Course {
  return CourseSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
