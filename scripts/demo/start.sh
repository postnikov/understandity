#!/bin/bash
# Works when invoked from bash, zsh or fish; never sources a shell profile.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONDONTWRITEBYTECODE=1
if [ "$#" -eq 0 ]; then set -- start; fi
exec python3.11 "$script_dir/demo.py" "$@"
