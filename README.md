# Understandity

Learning through "wow" on local models. A child (12–14) opens a micro-card, makes a prediction **by voice**,
gets one short Socratic question from a local tutor, and hears it spoken back — all on one laptop, offline.

Built at Hacktoberfest Hack Day Barcelona, 24.10.2026. Licensed under Apache-2.0.

> Status: skeleton. Every engine is a fake with plausible data; real engines (Gemma via Ollama, whisper.cpp,
> Qwen3-TTS via MLX, ComfyUI) plug into the same contracts module by module.

## Quick start

```bash
npm install
npm run dev      # server on http://127.0.0.1:8787, web on http://127.0.0.1:5173
npm test         # contract + API tests
npm run typecheck
```

Open http://127.0.0.1:5173 → card → "Answer by voice" → transcript "I heard: …" → tutor reply → voice.
Without a microphone the recorder sends a silent demo clip and says so.

## Architecture: four replaceable engines

The learning loop never knows a checkpoint or SDK. It talks to four adapters — **text, STT, TTS, image** — each with
`health()`, `listModels()`, `capabilities()` and explicit `EngineError` codes. Which provider and model run is a
setting, and the providers themselves (models, endpoints, voices) live in `config/engines.json`.

- **Offline profile** (default): cloud providers, non-loopback endpoints and hidden network fallbacks are refused —
  both when settings are saved and when an engine is called.
- **One heavy task at a time**: a local dispatcher serialises Gemma / ComfyUI / TTS and unloads the previous model.
- **Cloud is opt-in**: `gemini-api` (text fallback) and `elevenlabs` (TTS for prepared author text) are disabled
  placeholders; keys are read from env at runtime only, never stored in the repo. Child audio never leaves the machine.

## Module map

| Path | What |
|---|---|
| `packages/contracts` | zod schemas + TS types: course → concepts → cards (fact → question → key → rubric, adult review status), learning cycle steps, the four adapter contracts, dispatcher, settings & `engines.json` schema, HTTP DTOs, sidecar contract |
| `packages/dispatcher` | in-process "one heavy task" queue |
| `packages/course` | course generation interface (`CourseGenerator`), not implemented yet |
| `engines/<modality>-<provider>` | one package per engine provider: `text-fake`, `stt-fake`, `tts-fake`, `image-fake`, placeholders `text-gemini-api`, `tts-elevenlabs` |
| `apps/server` | Hono on Node, `127.0.0.1` only: `/api/course`, `/api/stt`, `/api/tutor`, `/api/tts`, `/api/image`, `/api/engines`, `/api/settings`, `/api/health` |
| `apps/web` | Vite + vanilla TS: card, voice recorder, engine settings; no CDN, system fonts |
| `sidecars/tts-mlx` | Python MLX voice sidecar — HTTP contract only |
| `config/engines.json` | providers, models, endpoints, voices, defaults |
| `content/demo-course.json` | hand-written demo course (physics: floating and density), status `needs_review` |

## Adding an engine

1. New package `engines/<modality>-<provider>` exporting a `ProviderModule` (see `engines/text-fake`).
2. One line in `apps/server/src/providers.ts`.
3. Provider entry in `config/engines.json` (with `locality`, `endpoint`, `models`).
4. Contract tests in `packages/contracts/test` pick it up via the base-contract suite.

## License

Apache License 2.0 — see `LICENSE`.
