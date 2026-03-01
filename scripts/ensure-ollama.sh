#!/usr/bin/env bash
set -euo pipefail

OLLAMA_BIN="${OLLAMA_BIN:-/usr/local/bin/ollama}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434/api/tags}"
OLLAMA_LOG="${OLLAMA_LOG:-/tmp/nanoclaw-ollama.log}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-30}"

is_ollama_ready() {
  curl -fsS --max-time 2 "$OLLAMA_URL" >/dev/null 2>&1
}

if is_ollama_ready; then
  exit 0
fi

if [ ! -x "$OLLAMA_BIN" ]; then
  echo "Ollama binary not found or not executable: $OLLAMA_BIN" >&2
  exit 1
fi

if ! pgrep -f "ollama serve" >/dev/null 2>&1; then
  nohup "$OLLAMA_BIN" serve >"$OLLAMA_LOG" 2>&1 &
fi

for _ in $(seq 1 "$STARTUP_TIMEOUT_SECONDS"); do
  if is_ollama_ready; then
    exit 0
  fi
  sleep 1
done

echo "Ollama did not become ready within ${STARTUP_TIMEOUT_SECONDS}s" >&2
exit 1
