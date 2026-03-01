#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[refresh:lite] Building host TypeScript..."
cd "$ROOT_DIR"
npm run build

echo "[refresh:lite] Restarting nanoclaw services (no container rebuild)..."
systemctl --user restart nanoclaw.service
systemctl --user restart nanoclaw-preview.service

echo "[refresh:lite] Done. Note: container image was NOT rebuilt."
