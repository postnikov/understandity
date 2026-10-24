# sidecars/tts-mlx — local voice over HTTP

Python 3.11 sidecar for `mlx-audio==0.5.4` + Qwen3-TTS (`mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit`,
revision pinned in `config/engines.json → providers.tts.mlx-qwen3.options.revision`).

The TypeScript side of this contract is `packages/contracts/src/sidecars.ts` (zod schemas). The
`engines/tts-mlx-qwen3` adapter talks to the sidecar through it.

## Rules

- Listens on `127.0.0.1` only, port from config (`endpoint`, default `http://127.0.0.1:8790`).
- Offline: `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`; weights come from the local HF cache, never auto-download.
- Own Python 3.11 venv in this folder (`.venv/`, gitignored), `mlx-audio==0.5.4`.
- One synthesis at a time; the Node dispatcher serialises heavy engines and calls `/unload` before another heavy engine runs.
- Every synthesis starts a fresh worker and reaps it before returning WAV. Model/Metal memory is released even if Python caches would otherwise retain it. `/unload` kills and reaps only this sidecar's worker; no other model process is touched.
- Health checks only the pinned local snapshot; it never imports MLX or loads the model. A broken runtime is established by synthesis, not by health alone.
- `Origin` headers and non-loopback Host values are refused. No CORS, no request text/audio logs. Temporary requests and WAVs are removed in `finally`.

## Install and run

From the repository root (install dependencies while online; weights must already be cached):

```sh
uv venv --python 3.11 sidecars/tts-mlx/.venv
uv pip sync --python sidecars/tts-mlx/.venv/bin/python sidecars/tts-mlx/requirements.lock
```

Long-running local servers belong in a dedicated tmux session. The example uses the port in `config/engines.json` (8790); check it is free. This does not install launchd or start on login.

```sh
tmux new-session -s dev-understandity-tts
sidecars/tts-mlx/.venv/bin/python sidecars/tts-mlx/server.py
```

`--config /absolute/path/engines.local.json` selects a different profile; `--port` overrides the listener port. Bind address always remains 127.0.0.1. Both Node and Python must read the same MLX model/revision/voice configuration. `cacheDir` is the Hugging Face hub directory, not a model file. The pinned snapshot includes `speech_tokenizer`; there is no download fallback.

```sh
sidecars/tts-mlx/.venv/bin/python -m unittest discover -s sidecars/tts-mlx -p 'test_*.py' -v
npm test -- engines
```

Explicit live benchmark (only with a running sidecar, an empty Ollama and no other heavy job; uses synthetic adult speech, no cloud calls):

```sh
node_modules/.bin/tsx engines/tts-mlx-qwen3/scripts/smoke.ts --run-local --output /tmp/engines-live-smoke.json
```

Dependencies were pinned from the working Python 3.11 environment on 2026-10-24. The first live process took 18.735 s; a second fresh process with warm OS/compiler caches took 2.033 s for the same 3.12 s Russian phrase. These are single Studio measurements; warm up before a demonstration. Whisper transcribed the complete synthesized sentence, including its negation; listening quality and a real child microphone were not evaluated.

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
