import type { Course, EnginesResponse, Settings, SettingsIssue, Transcript, TutorTurnReply, TutorTurnRequest } from '@understandity/contracts';

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok && body?.error) throw new ApiFailure(body.error.code, body.error.message);
  return body as T;
}

export const api = {
  course: () => fetch('/api/course').then((r) => json<Course>(r)),
  engines: () => fetch('/api/engines').then((r) => json<EnginesResponse>(r)),
  saveSettings: (s: Settings) =>
    fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).then((r) =>
      r.json() as Promise<{ ok: boolean; settings: Settings; issues: SettingsIssue[] }>,
    ),
  transcribe: (audio: Blob, lang: string, prompt: string) =>
    fetch(`/api/stt?lang=${encodeURIComponent(lang)}&prompt=${encodeURIComponent(prompt)}`, {
      method: 'POST',
      headers: { 'content-type': audio.type || 'audio/webm' },
      body: audio,
    }).then((r) => json<Transcript>(r)),
  tutor: (req: TutorTurnRequest) =>
    fetch('/api/tutor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }).then((r) =>
      json<TutorTurnReply>(r),
    ),
  speak: async (text: string, language: string): Promise<Blob> => {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, language }) });
    if (!r.ok) await json(r);
    return r.blob();
  },
  illustrate: (topic: string, style: string) =>
    fetch('/api/image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic, style }) }).then((r) =>
      json<{ state: string; file: string | null }>(r),
    ),
};
