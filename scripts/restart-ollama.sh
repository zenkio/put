#!/usr/bin/env bash
set -euo pipefail

# If Ollama is running, stop it so we can start a fresh instance.
if pgrep -f 'ollama serve' >/dev/null 2>&1; then
  if ! pkill -f 'ollama serve'; then
    echo "Warning: unable to kill existing Ollama process (permission denied)."
    echo "If you need to stop it first, run: sudo pkill -u ollama -f 'ollama serve'"
    echo "Then rerun this command."
  else
    sleep 1
  fi
fi

# Delegate to ensure script to start Ollama and wait for readiness.
./scripts/ensure-ollama.sh
