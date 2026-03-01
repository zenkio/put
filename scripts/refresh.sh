#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[refresh] Rebuilding container image nanoclaw-agent:latest..."
"$ROOT_DIR/container/build.sh"

echo "[refresh] Restarting nanoclaw services..."
systemctl --user restart nanoclaw.service
systemctl --user restart nanoclaw-preview.service

echo "[refresh] Done. Latest container code is now active."
