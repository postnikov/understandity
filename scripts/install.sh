#!/bin/bash
# Native Apple Silicon bootstrap. Dry-run never installs, starts a service, or downloads.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/demo/install.conf"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/python@3.11/bin:/usr/local/bin:$PATH"
export PYTHONDONTWRITEBYTECODE=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1
mode=install
case "${1:-}" in
  --dry-run) mode=dry-run ;;
  --help|-h)
    echo 'Usage: bash scripts/install.sh [--dry-run]'
    echo 'Installs the full local voice/text package on macOS Apple Silicon with Homebrew.'
    exit 0 ;;
  '') ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then echo 'Only one option is accepted.' >&2; exit 2; fi
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'Not supported yet: use native macOS Apple Silicon (not Linux, Intel Mac, or Rosetta).' >&2
  exit 2
fi
printf '\nUnderstandity full local package\n'
printf 'Models: about %s GB; allow %s GiB free disk for models, caches and dependencies.\n' "$MODEL_DOWNLOAD_GB" "$MIN_FREE_GIB"
printf 'Target: macOS %s+, %s GiB RAM or more (tested on 64 GiB; the lowest workable RAM is not benchmarked).\n' "$MIN_MACOS_MAJOR" "$MIN_RAM_GIB"
echo 'Installs Gemma, Whisper, Kokoro and Qwen3-TTS. No keys are read; no cloud calls or inference.'
echo 'Homebrew and its Command Line Tools must already be installed: https://brew.sh'
mac_major="$(sw_vers -productVersion)"; mac_major="${mac_major%%.*}"
ram_bytes="$(/usr/sbin/sysctl -n hw.memsize)"
free_kib="$(df -Pk "$repo_dir" | awk 'NR==2 {print $4}')"
printf 'Detected: macOS %s, RAM %s GiB, free disk %s GiB.\n' "$mac_major" "$((ram_bytes / 1024 / 1024 / 1024))" "$((free_kib / 1024 / 1024))"
if [ "$mac_major" -lt "$MIN_MACOS_MAJOR" ] || [ "$ram_bytes" -lt "$((MIN_RAM_GIB * 1024 * 1024 * 1024))" ] || [ "$free_kib" -lt "$((MIN_FREE_GIB * 1024 * 1024))" ]; then
  if [ "$mode" != dry-run ]; then echo 'Requirements not met. No installation performed.' >&2; exit 2; fi
  echo 'DRY RUN: requirements are not met; a real installation would stop.'
fi
if ! command -v brew >/dev/null 2>&1 && [ "$mode" != dry-run ]; then
  echo 'Homebrew is missing. Install it from https://brew.sh, then repeat this command.' >&2
  exit 2
fi
for formula in $BREW_FORMULAE; do
  case "$formula" in
    python@3.11) binary=python3.11 ;;
    whisper-cpp) binary=whisper-cli ;;
    *) binary="$formula" ;;
  esac
  missing=0
  if ! command -v "$binary" >/dev/null 2>&1; then missing=1; fi
  if [ "$binary" = node ] && [ "$missing" -eq 0 ]; then
    node_major="$(node --version)"; node_major="${node_major#v}"; node_major="${node_major%%.*}"
    if [ "$node_major" -lt 22 ]; then missing=1; fi
  fi
  if [ "$missing" -eq 1 ]; then
    if [ "$mode" = dry-run ]; then
      printf 'WOULD INSTALL: brew install %s\n' "$formula"
    else
      printf 'INSTALL: brew install %s\n' "$formula"
      brew install "$formula"
      hash -r
    fi
  else
    printf 'FOUND: %s\n' "$binary"
  fi
done
if [ "$mode" = dry-run ] && ! command -v python3.11 >/dev/null 2>&1; then
  echo 'WOULD RUN: npm ci; uv venv (Python 3.11); uv pip sync sidecars/tts-mlx/requirements.lock.'
  echo 'WOULD FETCH: the configured Ollama text model; pinned Whisper, Kokoro and Qwen3-TTS snapshots.'
  echo 'Exact model IDs and HF revisions are in config/engines.json; Whisper revision is in scripts/demo/install.conf.'
  echo 'Run --dry-run after Python 3.11 is available for the detailed cache/file plan. No changes made.'
  exit 0
fi
exec python3.11 -B "$repo_dir/scripts/demo/install.py" "$mode"
