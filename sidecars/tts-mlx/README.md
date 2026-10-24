# sidecars/tts-mlx — local voice over HTTP

Python sidecar that will wrap `mlx-audio` + Qwen3-TTS (`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`,
revision pinned in `config/engines.json → providers.tts.mlx-qwen3.options.revision`). **Only the place and the
HTTP contract exist yet — no implementation.**

The TypeScript side of this contract is `packages/contracts/src/sidecars.ts` (zod schemas). The future
`engines/tts-mlx-qwen3` adapter talks to the sidecar through it.

## Rules

- Listens on `127.0.0.1` only, port from config (`endpoint`, default `http://127.0.0.1:8790`).
- Offline: `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; weights come from the local HF cache, never auto-download.
- Own Python 3.11 venv in this folder (`.venv/`, gitignored), `mlx-audio==0.5.4`.
- One synthesis at a time; the Node dispatcher serialises heavy engines and calls `/unload` before another heavy engine runs.

## HTTP contract

### `GET /health` → 200

```json
{ "status": "ok", "model": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "loaded": false,
  "voices": ["Aiden"], "languages": ["ru", "en", "es"], "version": "0.1.0" }
```

`status`: `ok` | `loading` | `down`. `loaded` — model is in memory right now.

### `POST /synthesize`

Request (`application/json`):

```json
{ "text": "Важна не масса, а плотность.", "language": "ru", "voice": "Aiden",
  "instruct": "calm warm narrator", "sampleRateHz": 24000 }
```

Response 200: `audio/wav` bytes (mono PCM), headers `X-Duration-Sec`, `X-Model`, `X-Voice`.

### `POST /unload` → 204

Frees the model from memory. Idempotent.

### Errors

HTTP 4xx/5xx with JSON `{ "error": "<code>", "message": "…" }`, codes:
`bad_input` (400), `unsupported` (422, e.g. Catalan is not in the model's language list), `model_missing` (424),
`busy` (409), `internal` (500). The adapter maps them to `EngineError` with the same code.
