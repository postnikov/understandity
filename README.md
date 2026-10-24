# Understandity

An offline-first, open-source tutor for 12–14-year-olds, meant to run at home on a parent's computer.

Every lesson card starts with a "wow" question from school science or math. The kid guesses out loud, gets a short explanation of the cause, changes one thing, and then explains a new case by voice. The answer is transcribed on the computer, the kid confirms what was heard, and a local language model judges the explanation against an answer key an adult approved: it confirms a right cause, asks one follow-up question otherwise, and never gives the key away.

A local model also drafts the lessons. Models get facts wrong, so an adult reviews every **fact → question → key** before a child can open the card.

> You can delegate thinking, but you cannot delegate understanding.

Built at Hacktoberfest Hack Day Barcelona on 24.10.2026 by Max Postnikov with AI coding agents (see [How it was built](#how-it-was-built)). Licensed under Apache-2.0.

## How a card works

The kid picks a world (Fantasy or Anime in the demo courses, two more worlds in progress) and can switch it on any card. The world changes the scenes and pictures; the facts stay the same. Each card has six steps:

1. **Wow**: a question that shouldn't work but does, with a scene from the kid's world.
2. **Predict**, by voice: what happens and why. Being wrong here is fine.
3. **Explain**: the cause in a short text, with a picture of the scene.
4. **Try**, by voice: change exactly one thing and say what happens.
5. **New case**, by voice: a new situation, no hints. Explain how you decided.
6. **Wrap-up**: the card is done; the next one brings a new situation.

Answering by voice: press the mic, talk for up to 30 seconds, press **Done**. The screen shows **I heard: …** with **Yes, that is it** and **Record again**, because a recognition slip is not the kid's mistake. Silence gives "No answer received", never "did not understand". The tutor's reply appears as text while the model writes it, then a local voice reads it out. The kid can also type a question under the card or press **Just explain**.

For each turn the tutor gets the card's fact and conditions, the adult-approved key (with an instruction not to reveal it before the kid tries), the typical mistake and a clarifying question. It first judges the answer against the key by meaning: a right cause is confirmed out loud and followed by a new case; a bare prediction gets "why?"; a wrong cause gets a counterexample; "I don't know" gets a small hint. It answers in 2–4 short sentences with exactly one question, never states the key itself before the kid does, and never judges accent or wording. Only those guiding replies and **Just explain** count as hints; after two, it explains directly on a different example. It refuses to tutor a card an adult hasn't approved.

## What expertise is inside, and where it comes from

- **Teaching method.** Curiosity first: every card opens with a "wow" question. Then the kid's own world, and understanding over memorization: predict, find the cause, change one thing, explain a new case. On top sits Max Postnikov's rule that understanding can't be delegated: the kid explains out loud, and the tutor never gives the key away. The method comes from how Max teaches complex topics in his AI Anti-Magic course: start with curiosity, then check that understanding actually happened. The six-step learning cycle was drafted with an AI agent from these principles and approved by Max.
- **Subject knowledge.** OpenStax textbooks (CC BY 4.0): University Physics Volume 1, Biology 2e, Prealgebra 2e. The short source notes in `content/sources/` were written by an AI agent from the cited sections. The model takes facts only from them, and an adult approved every card's fact → question → key before the demo.
- **Tutoring rules.** Each card carries a typical mistake, a clarifying question and a rubric. The tutor judges the answer by meaning against the key, confirms a right cause, asks "why?" after a bare prediction, answers a wrong cause with a counterexample and gives a small hint after "I don't know"; after two hints it explains directly on a different example. It never grades accent, speed or wording, and a recognition slip never counts as the kid's mistake. The rules live in `apps/server/src/tutor-prompt.ts`.
- **Why an adult checks the facts.** While planning, we had local models draft five school courses, and every one had mistakes in facts or answer keys. Turning on the models' "thinking" mode didn't fix it.

## Before and after: the same model, without our part

The same model (Gemma 4 12B), the same student answers, two setups. **A** is the Understandity tutor: its prompt, verdict line, hint rule and the adult-approved key. **B** is the same model with a plain prompt, "You are a helpful assistant. Help a school student (12–14 years old) with their question.", given what the kid sees on the card and the kid's answer, with no key, rubric or rules. Measured on 16 scripted answers: two cards (physics and biology), four answer types (right cause, bare prediction, wrong cause, "I don't know"), two runs each, on our Mac Studio.

| | A: Understandity | B: same Gemma, plain prompt |
|---|---|---|
| Kid's answer judged right | 16 of 16 | 7 of 16 (6 wrong, 3 debatable) |
| Cause given away before the kid found it (12 answers that weren't right yet) | 0 clear, 4 debatable | 12 of 12; a ready "summary for your teacher" in 13 of 16 replies |
| Shape of the reply | one question at the end, 7–51 words | a lecture of 211–432 words, no question to the kid |
| Markdown or LaTeX in a reply the voice reads out | 0 of 16 | 16 of 16 |
| Physics mistakes in the explanation | 1 clear, 1 clumsy | 2 clear, 1 confused |
| Time to a full reply, median | 0.58 s | 5.2 s |

One pair, a bare prediction on the physics card, "The small piece will still sink.": A answers "The small piece will still sink. Why?". B answers "Your answer is **correct**!", explains density itself and adds a ready-made summary for the teacher.

Where B is better: a kid who just wants the full answer gets it from B at once, with more detail; A holds it back on purpose. A's weak spot: on a wrong physics answer its counterexample was once physically wrong and once clumsy.

Limits: the answers were written for the test, not given by children; text only, no voice; English only; one grader who knew which setup was which. B could answer up to 600 tokens and A up to 200; no B reply hit its limit. A prompt like "don't give the answer right away" would make B better, but that would already be our part.

## Why local

A child explaining out loud what they don't understand is sensitive learning data, and a 12-year-old usually can't consent to sharing it on their own. When the models run on the family computer, there is no third party to share it with: privacy comes from how the system is built, not from a promise in a policy. It also means no accounts, no per-student token bill, and lessons that keep working when parents switch the internet off.

What the code does about it:

- The server listens on `127.0.0.1` only. The web app loads nothing from a CDN; the font (JetBrains Mono) is bundled.
- The default **Offline** profile refuses cloud providers, non-loopback endpoints and hidden network fallbacks, both when settings are saved and again on every engine call.
- Recordings are temporary: converted, transcribed and deleted, also when something fails. There is no recording history.
- The app never downloads models. Whisper and both voice sidecars use weights already on disk, pinned to a snapshot, and fetch nothing at runtime.
- Scene pictures were drawn in advance by a cloud model (Nano Banana Pro) and ship as image files in `content/media`, so the lesson needs no network for them. A scene without a picture gets a built-in SVG scheme. No model draws anything at lesson time.
- No keys in the repo. `config/engines.json` holds only the name of an environment variable. Cloud engines are never called on their own: not in health checks and not as a fallback when a local engine fails.

## Architecture

The learning loop doesn't know any model or SDK. It talks to four swappable engines (**text, speech-to-text, text-to-speech, images**) through one adapter contract: `health()`, `listModels()`, `capabilities()` and explicit `EngineError` codes. Which provider and model runs is a setting on the **Engines** screen; providers, models, endpoints and voices live in `config/engines.json`.

```text
browser   http://127.0.0.1:5173          Vite + vanilla TS
  │  /api, /media
server    127.0.0.1:8787                 Hono on Node 22
  ├─ /api/courses*                       courses and the adult gate (content/*.json)
  ├─ /api/tutor/stream                   one tutor turn, streamed (SSE)
  ├─ /media/*                            pre-made scene pictures (content/media)
  └─ EngineHub                           Offline rule checked on every call
       └─ dispatcher                     one heavy task at a time
            ├─ text    Ollama 127.0.0.1:11434         Gemma 4 12B
            ├─ stt     whisper-cli                    Whisper large-v3-turbo
            ├─ tts     voice by language
            │            en  MLX sidecar 127.0.0.1:8791   Kokoro-82M (light, stays loaded)
            │            ru  MLX sidecar 127.0.0.1:8790   Qwen3-TTS (heavy)
            └─ image   fake · ComfyUI 127.0.0.1:8189    optional, not used by the lesson
```

**One heavy task at a time.** Gemma, Whisper, the Qwen3 voice and ComfyUI are marked heavy. The dispatcher runs them one after another (FIFO, with a timeout and a `busy` answer) and unloads the previous model before the next one starts. Unloading is a barrier: the slot isn't freed just because an HTTP wait ended, because the model may still be working. Kokoro and macOS `say` are light: an English voice turn goes Whisper → Gemma → Kokoro, and speaking doesn't unload Gemma.

| Path | What |
|---|---|
| `packages/contracts` | zod schemas and types: course → concepts → cards (fact → question → key → rubric, adult review status), the learning cycle, the four adapter contracts, error codes, the dispatcher, settings with the Offline rule, HTTP DTOs, the voice sidecar contract |
| `packages/dispatcher` | the one-heavy-task queue |
| `packages/course` | course generator, adult review logic, CLI |
| `engines/<modality>-<provider>` | one package per provider, plus a `fake` for every modality |
| `apps/server` | Hono API on `127.0.0.1`, the tutor, the engine hub |
| `apps/web` | world and course choice, the learning cycle with voice states, built-in SVG scene schemes, the adult check, the engines screen; English UI, Russian available |
| `sidecars/tts-mlx` | Python 3.11 voice sidecars on MLX, one venv with a pinned lock: Qwen3-TTS (`server.py`, a fresh worker per synthesis, so memory is released) and Kokoro-82M (`kokoro_server.py`, stays loaded) |
| `config/engines.json` | providers, models, endpoints, voices, defaults |
| `content/` | courses (`*.json`), source notes (`sources/*.md`), pre-made scene pictures (`media/`) |

## What runs by default

| Modality | Provider and model | Where | Role | Checked |
|---|---|---|---|---|
| Text | Gemma 4 12B (`gemma4:12b-mlx`) via Ollama | local | default: tutor and course drafts | live: three courses generated |
| Text | `qwen3.8:27b-mlx` via Ollama | local | alternative | configured |
| Text | Gemini API | cloud | off | placeholder, not implemented |
| Speech → text | Whisper large-v3-turbo via whisper.cpp | local | default | live |
| Speech → text | Gemma 4 12B audio input via Ollama | local | alternative | live |
| Speech → text | ElevenLabs Scribe v2 (sends the recording) | cloud | off | HTTP mocks only |
| Text → speech | Kokoro-82M (bf16, MLX), voice `af_heart` | local | default for English (voice by language) | live and offline on the Mac Studio |
| Text → speech | Qwen3-TTS 1.7B (8-bit MLX), voice Aiden | local | default for Russian (voice by language) | live |
| Text → speech | macOS `say` | local | emergency, picked on the Engines screen | live |
| Text → speech | ElevenLabs Multilingual v2 (sends the text) | cloud | off | HTTP mocks only |
| Pictures | 30 scene pictures drawn in advance by Nano Banana Pro (cloud), shipped as files in `content/media` | files | default for Fantasy and Anime | in the repository |
| Pictures | built-in SVG scene schemes, drawn in the browser | local | fallback when a scene has no picture | in use |
| Pictures | ComfyUI with Z-Image Turbo, live | local | optional, not used by the lesson | HTTP mocks only |

Cloud providers are `enabled: false` in the config, and the Offline profile refuses them even when enabled. Using one is explicit: switch to the Online profile, set `enabled: true`, put the key in the environment variable named by `secretEnv` (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`) and pick the provider on the Engines screen. For a stock ComfyUI, set `apiMode: native`, `secretEnv: null` and its endpoint in `config/engines.json`.

## Models and their licenses

| Model | Used for | License |
|---|---|---|
| Gemma 4 12B (Google DeepMind), run as `gemma4:12b-mlx` in Ollama | tutor, course drafts, optional speech-to-text | [Apache 2.0](https://ai.google.dev/gemma/apache_2) |
| Whisper large-v3-turbo (OpenAI), run with whisper.cpp | speech-to-text | [MIT, see the model card](https://huggingface.co/openai/whisper-large-v3-turbo) |
| Kokoro-82M, MLX build `mlx-community/Kokoro-82M-bf16` | English voice | [Apache 2.0, see the model card](https://huggingface.co/hexgrad/Kokoro-82M) |
| Qwen3-TTS 12Hz 1.7B CustomVoice, MLX build `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` | Russian voice | [Apache 2.0, see the model card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice) |
| Nano Banana Pro (Google), cloud | the 30 scene pictures, drawn in advance; not part of the runtime | proprietary, used under Google's terms |

Optional engines that are off by default (`qwen3.8:27b-mlx`, ComfyUI with Z-Image Turbo, ElevenLabs, Gemini API) come with their own licenses and terms.

## The adult gate and the courses

- The generator writes every card as `needs_review`. The student screen gets only approved cards (`GET /api/courses/:id/showable`); blocked cards never reach it.
- The **Adult check** screen shows, for each card, the fact (with its conditions and source), the question, the key (with the typical mistake and a follow-up) and the generator's warnings. Buttons: **Approve**, **Block**, **Fix** (edit the fact, question or key, then save and approve). Writes are atomic.
- The tutor reads the course from disk on every turn, so a fixed key reaches it at once.
- Generator warnings never approve anything. They flag explanations outside 40–60 words, absolute words (always, only, never), requests to write or choose instead of explaining, questions that ask to recall, voice questions that repeat the hook or the Try step, and the model's own doubts.
- For development only, `UNDERSTANDITY_ALLOW_DRAFTS=1` (server) and `VITE_ALLOW_DRAFTS=1` (web) show unchecked cards with a "Draft · not checked by an adult" mark. Blocked cards are never shown.
- Limit: the gate covers fact → question → key. It doesn't show or edit the explanation, the Try step or the world scenes yet; an adult can only block the whole card.

Demo courses: English, five cards each, Fantasy and Anime worlds with a pre-made picture for every card in both, drafted on 24.10 by Gemma 4 12B from short source notes and approved by Max Postnikov. The picture prompts are in `content/media/prompts.json`.

| Subject | Course | File | Source |
|---|---|---|---|
| Physics | Why do some heavy things float? | `content/heavy-things-sink.json` | OpenStax University Physics Volume 1, 14.1 and 14.4 |
| Biology | Where does a tree's weight come from? | `content/light-plant-growth.json` | OpenStax Biology 2e, 8.1 and 8.3 |
| Math | The Growing Square Mystery | `content/double-side-area.json` | OpenStax Prealgebra 2e, 9.4 |

`content/demo-course.json` is a short hand-written course in Russian that nobody checked: it stays on the home screen as "Waiting for an adult check" and can't be opened as a student.

## Quick start

Default setup: a Mac with Apple Silicon, Node 22 or newer, Ollama 0.40.8 or newer with `gemma4:12b-mlx`, ffmpeg, `whisper-cli` with `~/.cache/whisper-cpp/ggml-large-v3-turbo.bin`, and Python 3.11 with uv for the voice sidecars (the Qwen3-TTS snapshot must already be in the Hugging Face cache; Kokoro is downloaded once with the command below). We run it on Macs with 64 GB of memory; the full set of model weights we use is about 51 GB.

```sh
npm ci   # installs exactly the versions pinned in package-lock.json

# voice sidecars, once, while online
uv venv --python 3.11 sidecars/tts-mlx/.venv
uv pip sync --python sidecars/tts-mlx/.venv/bin/python sidecars/tts-mlx/requirements.lock
sidecars/tts-mlx/.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Kokoro-82M-bf16', revision='a71e4d38b236d968966a2002c4c895dbd12b1c3c', allow_patterns=['config.json','kokoro-v1_0.safetensors','voices/*.safetensors','VOICES.md'])"

# keep both voice sidecars running, each in its own terminal
sidecars/tts-mlx/.venv/bin/python sidecars/tts-mlx/kokoro_server.py   # English
sidecars/tts-mlx/.venv/bin/python sidecars/tts-mlx/server.py          # Russian

# in another terminal
npm run demo
```

Open http://127.0.0.1:5173 (browsers allow the microphone on localhost) → pick a world and a course → **Start** → **Next** → **Answer by voice** → talk → **Done** → **Yes, that is it**.

- `npm run demo` is `npm run dev` with `UNDERSTANDITY_WARMUP=1`: the server makes one short synthesis per voice at start, English first, so the first spoken reply isn't a cold start. Plain `npm run dev` loads nothing heavy at start.
- The server runs on `127.0.0.1:8787`, the web app on `127.0.0.1:5173`. Check: `curl -s http://127.0.0.1:5173/api/health` returns `"ok":true` when every active engine is up.
- No microphone: the recorder sends a silent demo clip and says so.
- No models: on the **Engines** screen pick `fake` for every modality and press **Apply** to click through the loop with placeholder data.
- Environment: `UNDERSTANDITY_PORT`, `UNDERSTANDITY_WEB_PORT`, `UNDERSTANDITY_ENGINES`, `UNDERSTANDITY_COURSE`, `UNDERSTANDITY_CONTENT_DIR`, `UNDERSTANDITY_ALLOW_DRAFTS`, `UNDERSTANDITY_WARMUP`.

### Make a course

```sh
npm run course:generate -- --concept "…" --source content/sources/<id>.md --lang en --out content/<id>.json [--cards 5] [--worlds fantasy,anime] [--model qwen3.8:27b-mlx] [--unload]
```

- The source note is Markdown with front matter (`source`, `url`, `subject`); its body holds the subject notes the course is built from, and an adult should check them. The model takes facts only from the note, and every card links back to the source.
- Five cards took 40–45 seconds with Gemma 4 12B on our Mac Studio. Every card comes out as `needs_review`: open **Adult check** and approve, fix or block each one.
- Heavy models run one at a time: the CLI refuses to start while another model is loaded in Ollama (check with `ollama ps`).
- `--out` overwrites an existing file without asking. Use a new file name.

## Tests

```sh
npm test            # vitest
npm run typecheck   # tsc
npm run build       # web bundle
sidecars/tts-mlx/.venv/bin/python -m unittest discover -s sidecars/tts-mlx -p 'test_*.py' -v
```

The Vitest suite covers the contracts, the dispatcher (timeouts, cancellation, unload as a barrier), every engine adapter against HTTP or CLI fakes, the course generator on a scripted model (valid run, one repair, failure), the tutor's verdict line and hint rule, the review API and the server end to end. Server tests pin fake engines (`apps/server/test/helpers.ts`), so they don't depend on the demo defaults. A separate regression test runs speech-to-text → text → voice → speech-to-text through the dispatcher. The Python tests cover both voice sidecars, including snapshot checks, cleanup, killing and reaping the Qwen3 worker, and refusing browser origins.

## Measured

Single runs on our Mac Studio with synthetic adult speech. Not a child's voice, not a noisy room, not the demo laptop, not p95.

- Whisper large-v3-turbo: 1.08 s for a 4.76 s phrase; the meaning and the number in it were kept.
- Gemma 4 12B audio input: 2.50 s including the first load, 0.26 s with the model loaded, but it misheard the first word. That's why Whisper is the default and the kid always confirms the transcript.
- Qwen3-TTS via MLX, now the Russian voice: 18.7 s for the first process in a fresh environment, 2.0 s for the next fresh process, for 3.12 s of speech. Whisper read the generated phrase back correctly. Hence the warm-up in `npm run demo`.
- macOS `say`: 1.0 s.
- Course generation with Gemma 4 12B, five English cards: 40.2–44.1 s per course; all three passed validation on the first attempt.
- Tutor replies with Gemma 4 12B: 16 of 16 answers judged right, median 0.58 s to a full reply; the comparison with the same model without our part is in [Before and after](#before-and-after-the-same-model-without-our-part).

## Not done yet

As of 24.10.2026, during the hackathon:

- A pass with a live microphone in a real browser is a manual check that is still pending. The voice loop on the real engines (Whisper → Gemma → Qwen3-TTS) has passed end to end with synthetic speech, and the launcher smoke has passed on the demo MacBook.
- Two more worlds are in progress; the demo courses have scenes and pictures for Fantasy and Anime only.
- Evidence per answer is minimal: the tutor model's own verdict against the key (cause, hints used, transfer on the new case). It is not double-checked, the prediction itself is not extracted, and nothing is tracked across cards.
- Cards go in order; picking the next card from the kid's answer is not built.
- The adult gate doesn't cover the explanation, the Try step and the scenes (see above).
- There is no filter yet for what the model says to a child. It is required before real use with children.
- No installer: models are installed by hand.
- The Gemini API provider is a placeholder. ElevenLabs has never been called live. Live ComfyUI through the app has only been tested against HTTP mocks.
- Not tested with real children's voices. Minimum hardware is not measured.

## Add an engine

1. A package `engines/<modality>-<provider>` exporting a `ProviderModule`. The factory gets its config from `config/engines.json` (endpoint, models, options): no model names or paths in code.
2. A heavy engine sets `heavy: true` and implements `unload(model)`; the dispatcher unloads it before another heavy engine runs.
3. Errors only as `EngineError` with a code from the contract. Silence in speech-to-text is `no_speech`. No hidden fallbacks to the cloud.
4. One line in `apps/server/src/providers.ts`, `enabled: true` in the config, and a case in `packages/contracts/test`.

## How it was built

**Max Postnikov** brought the idea and the four principles behind it: curiosity first, the kid's own world, understanding over memorization, and "you can delegate thinking, but you cannot delegate understanding". He made the product decisions during the day and acted as the adult reviewer, approving the cards of the three demo courses before a child could see them. He wrote no code.

AI tools, credited as the hackathon rules ask:

- **Claude Code** and **Codex** (AI coding agents) wrote the code, the tests and these docs on 24.10.2026, from scratch. They worked in parallel modules held together by one shared contracts package.
- **Gemma 4 12B** drafted the three demo courses from the source notes; an adult reviewed every card.
- **Nano Banana Pro** drew the 30 scene pictures in advance (prompts in `content/media/prompts.json`).

## Libraries and tools

npm packages, exact versions pinned in `package-lock.json`:

- runtime: `hono`, `@hono/node-server`, `zod`, `@fontsource/jetbrains-mono`;
- build and tests: `vite`, `typescript`, `tsx`, `vitest`, `concurrently`, `@types/node`.

Python packages for the voice sidecars, exact versions pinned in `sidecars/tts-mlx/requirements.lock`: `mlx-audio` (with `mlx`), `soundfile`, `misaki`, `spacy` with the `en_core_web_sm` model, `num2words`, `phonemizer-fork`, `espeakng-loader`, and `huggingface-hub` for the one-time Kokoro download.

Tools: Node.js 22, Python 3.11, uv, Ollama, whisper.cpp (`whisper-cli`), ffmpeg; ComfyUI only for the optional live image engine.

## License

Apache License 2.0, see [LICENSE](LICENSE). Model weights are not part of this repository and come with their own licenses (see [Models and their licenses](#models-and-their-licenses)).

## Credits

- **OpenStax**, CC BY 4.0: the course sources come from [University Physics Volume 1](https://openstax.org/books/university-physics-volume-1/pages/14-1-fluids-density-and-pressure) (14.1, 14.4), [Biology 2e](https://openstax.org/books/biology-2e/pages/8-1-overview-of-photosynthesis) (8.1, 8.3) and [Prealgebra 2e](https://openstax.org/books/prealgebra-2e/pages/9-4-use-properties-of-rectangles-triangles-and-trapezoids) (9.4). The notes in `content/sources/` are short summaries written for this project, with links to these sections.
- **JetBrains Mono** (SIL Open Font License 1.1), bundled through `@fontsource/jetbrains-mono`.

Author: Max Postnikov.
