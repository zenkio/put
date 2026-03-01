#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAINT_FLAG="$ROOT_DIR/data/maintenance.flag"
WAIT_SECONDS="${SAFE_REFRESH_WAIT_SECONDS:-60}"

echo "[refresh:safe] Entering maintenance mode..."
mkdir -p "$ROOT_DIR/data"
echo "$(date -Iseconds)" > "$MAINT_FLAG"
cleanup() {
  rm -f "$MAINT_FLAG"
}
trap cleanup EXIT

echo "[refresh:safe] Waiting for in-flight container jobs to finish (up to ${WAIT_SECONDS}s)..."
if command -v docker >/dev/null 2>&1; then
  elapsed=0
  while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
    running="$(docker ps --filter "ancestor=nanoclaw-agent:latest" --format '{{.ID}}' | wc -l | tr -d ' ')"
    if [ "$running" = "0" ]; then
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
else
  sleep 3
fi

echo "[refresh:safe] Running lite refresh..."
bash "$ROOT_DIR/scripts/refresh-lite.sh"

echo "[refresh:safe] Exiting maintenance mode."
rm -f "$MAINT_FLAG"
trap - EXIT
echo "[refresh:safe] Done."
