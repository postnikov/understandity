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

/** Build features from `config/features.json` (not env): today only the adult check. Missing file = gate on. */
export function loadFeatures(path = resolve(REPO_ROOT, 'config/features.json')): { adultCheck: boolean } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { adultCheck?: unknown };
    return { adultCheck: raw.adultCheck !== false };
  } catch {
    return { adultCheck: true };
  }
}
