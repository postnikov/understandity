# Install Understandity

The full local package currently supports **macOS 15+ on Apple Silicon**. Linux, Windows, Intel Macs and Rosetta are not supported by this installer yet.

## Before you begin

- Install [Homebrew](https://brew.sh) and its Apple Command Line Tools prerequisite first. The project command below installs the missing application dependencies through Homebrew; it does not bootstrap Homebrew itself.
- The installer targets **32 GiB RAM or more**. Development and live voice tests used 64 GiB Macs; the lowest workable RAM has not been benchmarked. The 32 GiB check is a conservative installation policy, not a measured minimum.
- Allow **30 GiB free disk** on the project and home/cache volumes. Model downloads total approximately **12.8 GB**, plus Homebrew/npm/Python dependencies and cache space. Existing valid models are reused.
- Use an internet connection for installation. Afterward, the default profile runs locally without internet. An online-only lightweight installer is not included yet.
- Download and extract the project into a writable folder. Run the commands from that folder. Stop any running copy of Understandity before installing or updating dependencies.

## Install with one command

```bash
bash scripts/install.sh
```

The script prints the expected downloads and hardware requirements before it changes anything. It installs missing Node, Python 3.11, ffmpeg, whisper.cpp, Ollama, tmux and uv, installs the locked npm packages, builds the voice sidecar venv from its lockfile, and prepares all four local models below. It then verifies a second npm installation with `--offline` and runs a preflight without loading models or making paid API calls.

To inspect the plan without installing, downloading, or starting anything:

```bash
bash scripts/install.sh --dry-run
```

If Node is already installed, the equivalent npm entry point is:

```bash
npm run setup
```

On a machine without Python 3.11, dry-run prints the bootstrap actions and model groups. The detailed per-file cache plan becomes available after Python 3.11 is installed. A real installation installs Python through Homebrew before running that part of the installer.

## What gets installed

| Component | Purpose | Model source |
|---|---|---|
| Gemma 4 12B MLX | Local tutor | Public Ollama tag [`gemma4:12b-mlx`](https://ollama.com/library/gemma4:12b-mlx), about 7.7 GB |
| Whisper large-v3-turbo | Local speech recognition | [whisper.cpp weights](https://huggingface.co/ggerganov/whisper.cpp), about 1.62 GB; pinned revision and SHA256 |
| Kokoro 82M BF16 | English voice | [MLX snapshot](https://huggingface.co/mlx-community/Kokoro-82M-bf16), about 0.33 GB for the model and configured voices |
| Qwen3-TTS 1.7B 8-bit | Russian voice | [MLX snapshot](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit), about 3.08 GB including its speech tokenizer |

The public Gemma tag and anonymous registry manifest were checked on 2026-10-24. It is not a private local alias. The installer uses the configured tag and never silently substitutes another model. Ollama tags can change upstream; the two Hugging Face voice snapshots use full immutable commit revisions from `config/engines.json`:

- Kokoro: `a71e4d38b236d968966a2002c4c895dbd12b1c3c`
- Qwen3-TTS: `41d3337e8b7f2843a75841595fc14e4b9a7a4b96`

Whisper uses revision `5359861c739e955e79d9a303bcbc70fb988958b1` of its repository. The installer checks the complete file against SHA256 `1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69` before making it available. Interrupted downloads resume from a separate partial file. An existing file with a bad checksum is preserved and reported, never overwritten silently.

The Python lock includes MLX Audio, Kokoro's English G2P dependencies, the pinned spaCy English model and espeak fallback. Installing those dependencies in advance prevents an unexpected language-model download while offline. Kokoro and Qwen3 use the same Python 3.11 venv; voices and tokenizers are included in the pinned snapshots. The default install does not download Qwen 27B or ComfyUI/diffusion models.

## Start and stop

Start the complete stack:

```bash
bash scripts/demo/start.sh
```

Wait for `DEMO READY`, then open **http://127.0.0.1:5173**. The launcher starts the two voice sidecars, API and web app, and checks synthetic speech through the local engines. First-time voice warmup may take around 40 seconds or longer; subsequent calls are much faster. The `INSTALL COMPLETE` message itself means dependencies and files passed preflight, not that inference or your microphone has already been tested.

Ollama is reused if it is already running. If its local daemon is absent, the launcher starts it in a dedicated tmux session, including after a reboot. It does not download weights during startup or install a login service. An existing incompatible server or occupied port is reported rather than killed.

Stop the application and unload its models:

```bash
bash scripts/demo/start.sh stop
```

The idle Ollama daemon remains available. If the installer/launcher started it in `dev-understandity-ollama` and you also want that daemon stopped:

```bash
 tmux kill-session -t dev-understandity-ollama
```

Do not use that command to stop an unrelated Ollama application; the named session is created only when no local daemon was available.

## Offline mode

Every launcher start begins with the default **Offline** profile. The tutor uses Gemma, answers are transcribed by Whisper, English speech uses Kokoro, and Russian speech uses Qwen3. Prepared pictures and SVG fallbacks are local. Downloaded model files, npm packages and fonts remain available without internet.

Cloud entries can appear in the Engines catalog, but selected engines and voice routes must remain local in Offline. There is no automatic cloud fallback. The application refuses a cloud call in this profile even when a key has previously been saved.

After the first successful start, test your browser microphone and the learning cycle with the network disconnected. A preflight or localhost API test alone does not establish physical offline operation or microphone permission.

## Online mode with your own keys

Use the same launch command and open **Engines → API keys**:

1. Save an **Anthropic** key for the Claude tutor, and/or an **ElevenLabs** key for cloud speech recognition and speech generation.
2. Select **Online**.
3. Choose the desired cloud provider and model for each modality, then select **Apply**. Local and cloud modalities can be mixed.

Online is unavailable until at least one key is saved. One provider's key does not unlock another provider. Choosing ElevenLabs speech recognition sends the recorded answer to ElevenLabs; cloud text/voice operations send the corresponding request to their provider and use your provider account.

The app stores Settings keys in `data/keys.local.json`, a local plaintext file with owner-only permissions (0600) in the gitignored `data/` directory. The UI reports whether a key is set without returning its value. The installer never creates, reads or edits this file. Keep the `data/` directory out of copies you share.

Supported key names are `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` and `GEMINI_API_KEY`. The Gemini key field exists, but the Gemini text adapter is still a placeholder: use Anthropic for cloud tutoring in this version.

The demo launcher intentionally does not forward shell API-key environment variables; use the app's key fields with this launcher. For a manually started server, explicitly supplied environment keys take precedence over file keys and cannot be edited through Settings. Keys persist on disk; each launcher start still returns to Offline defaults. Deleting the last key while Online also returns the app to Offline defaults.

## Repeat installation and troubleshooting

Run the same installer after updating the source/lockfile. It reuses installed tools, valid Whisper weights, installed Ollama models, and complete pinned HF snapshots; npm and Python packages are synchronized to the project's locks. Config, courses and saved API keys are preserved. Only one installer may run for a project folder at a time.

- **Homebrew missing:** install it from the official site, then repeat the project command.
- **A tool is too old:** the installer adds missing Homebrew tools; an existing incompatible Ollama server must be updated/restarted before continuing. It does not stop your model server behind your back.
- **A demo port is occupied:** stop your running demo first. Ports are 5173 (web), 8787 (API), 8790 (Qwen3 voice), 8791 (Kokoro), and the configured Ollama endpoint, normally 11434.
- **Offline npm cache is incomplete:** reconnect and repeat the installer or the documented preparation step in [the launcher runbook](scripts/demo/README.md).
- **Whisper checksum mismatch:** preserve/rename the reported bad file before trying again; do not rename an incomplete partial file into the final model path.
- **Warmup fails:** inspect `sidecars/tts-mlx/.venv/demo-runtime/status.json` and the neighboring logs. The launcher does not print readiness when a model call fails.

Locations:

| Files | Default location |
|---|---|
| Node dependencies | `node_modules/` |
| Voice environment and demo logs | `sidecars/tts-mlx/.venv/` |
| Hugging Face snapshots | `~/.cache/huggingface/hub/` |
| Whisper weights | `~/.cache/whisper-cpp/` |
| Ollama weights | `~/.ollama/models/` |
| Installer lock and its optional Ollama log | `~/Library/Caches/Understandity/install/<project-id>/` |
| Saved API keys | `data/keys.local.json` |

Model IDs, voice revisions and runtime paths are in `config/engines.json`. Installer requirements and Whisper integrity metadata are in `scripts/demo/install.conf`. A source archive with these files and the lockfiles is sufficient; no personal machine configuration or team services are needed.
