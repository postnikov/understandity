# MacBook offline demo

One command, **after main and these scripts have synced from Studio**:

```bash
cd ~/Vibe/understandity
bash scripts/demo/start.sh
```

The command runs `npm ci --offline --no-audit --no-fund`, starts a dedicated tmux session,
selects the canonical Offline defaults through the API, warms Gemma, then each voice route — English (Kokoro) first, then Russian (Qwen3-TTS) — in sequence,
checks a synthetic voice → Whisper round trip (including the word “не”), then starts the web UI.
Wait for `DEMO READY http://127.0.0.1:5173`. A failed check never prints readiness.
No automatic cloud, fake-voice or online-install fallback exists.

Default engines follow the merged application config: Gemma tutor, Whisper large-v3-turbo,
voice by language (English → Kokoro-82M/af_heart, Russian → MLX Qwen3-TTS/Aiden; the expected routes are pinned in `demo.json → voiceRoutes`, any other route is refused), local SVG fallback plus already rendered course images. The launcher never
rewrites app config, course JSON, lockfiles or source code. It refuses an unexpected provider
change rather than silently replacing the builder's choices. Model IDs, voices and snapshot
revision come from `config/engines.json`; launcher limits/ports live in `scripts/demo/demo.json`.

## Prepare while online

Only project dependencies, no model downloads. This step never starts a server or inference:

```bash
cd ~/Vibe/understandity
bash scripts/demo/start.sh prepare
```

Preparation installs the locked npm dependencies and immediately verifies a second installation
with npm in offline mode. A changed lockfile/workspace manifest during Syncthing delivery fails
the check. Re-run preparation after the final lockfile changes, before disconnecting the network.

The sidecar environment must already exist. Initial setup, if it has not been prepared:

```bash
cd ~/Vibe/understandity
uv venv --offline --python /opt/homebrew/bin/python3.11 sidecars/tts-mlx/.venv
uv pip sync --offline --python sidecars/tts-mlx/.venv/bin/python sidecars/tts-mlx/requirements.lock
```

If the uv cache is incomplete, stop and prepare the missing **dependencies** while online; these
commands do not download models. Required weights: configured Gemma in Ollama, the pinned Kokoro snapshot with its voices (plus `misaki` and spaCy `en_core_web_sm` in the sidecar .venv), the pinned MLX
snapshot including its speech tokenizer, and the configured Whisper file. Do not copy an existing
venv from another machine. Do not use `brew list` for an offline inventory: it can refresh API data.

## Check and stop

Read-only admission check, without loading a model or starting a server:

```bash
bash scripts/demo/start.sh preflight
```

A short live smoke starts the same stack, does the same warmup/checks, then stops its own processes:

```bash
bash scripts/demo/start.sh smoke
```

For an already running demo:

```bash
bash scripts/demo/start.sh check
bash scripts/demo/start.sh stop
```

`check` reads app health through the web proxy and checks that selected models are installed and
healthy, runtime settings match the requested Offline profile, and every selected provider is local
and uses only loopback. Cloud entries may exist in the catalog; an active cloud selection is refused. The HTML entry is checked for external `src`/`href` assets.
This is a **local execution check**, not a packet capture, real microphone/browser test, full
JS asset audit or proof of physical network disconnection. Final acceptance on the MacBook must
include opening the UI and recording an answer after Wi-Fi/Tailscale are disconnected by Max.
An SSH smoke cannot prove that physical condition.

## Process ownership and files

- tmux session: `dev-understandity-demo`; the launcher marks the repository owner and refuses
  to stop someone else's session. Busy ports and any resident Ollama model stop admission.
  Do not stop another application's model just to pass this check.
- Existing ports: web 5173, server 8787; MLX ports from the configured endpoints (Qwen3 8790, Kokoro 8791).
  A missing local Ollama daemon is started in `dev-understandity-ollama` (no pull, no login item),
  so the launch command also works after a reboot. An existing daemon is reused; an old or occupied endpoint
  gives an error. Stopping the demo unloads its model but leaves this daemon available.
  MC, HQ, launchd and ComfyUI are never started by this launcher.
- App/sidecar processes receive an exact environment allowlist and offline HF flags; shell API keys are not forwarded.
  The app can read keys saved by its Settings screen in `data/keys.local.json`; the launcher never reads or writes them.
  Cloud catalog entries cannot be selected in Offline. See [INSTALL.md](../../INSTALL.md) for Online mode.
- Persistent diagnostics: `sidecars/tts-mlx/.venv/demo-runtime/` (`status.json`,
  `dependencies.json`, `supervisor.log`, `npm-ci*.log`, `server.log`, `web.log`, `tts.log`).
  These are ignored by git/Syncthing. Runtime temporary files also stay inside this directory;
  Python bytecode is disabled. No logs or generated config are written into synced repo paths.
- Cleanup sends signals only to child process groups created by this invocation, reaps them,
  releases its Gemma model, and records `EXIT=`. It does not kill by port or process name.
- A ready status is scoped by a fresh run ID; an old `status.json` cannot prove a new start.
  A failed startup cleans up its own children. `smoke` does not stop a session that existed before it.

## Fixture tests

Use a task-owned temporary directory. No live registry, inbox, model, dependency install or repo
configuration is mutated by the tests:

```bash
PYTHONDONTWRITEBYTECODE=1 python3.11 -m unittest discover -s scripts/demo -p 'test_*.py' -v
bash -n scripts/demo/start.sh
```
