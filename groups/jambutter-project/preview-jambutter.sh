#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/projects/jambutter"
npm run preview

expected_version="$(node -p "require('./package.json').version")"
active_file="$SCRIPT_DIR/.data/preview/.active"
settings_assets="$SCRIPT_DIR/.data/preview/jambutter/assets"

test -f "$active_file"
active_project="$(cat "$active_file")"
if [[ "$active_project" != "jambutter" ]]; then
  echo "Preview deploy verification failed: active project is '$active_project'" >&2
  exit 1
fi

if ! grep -Rqs "$expected_version" "$settings_assets"/settings-*.js; then
  echo "Preview deploy verification failed: version '$expected_version' not found in settings assets" >&2
  exit 1
fi

echo "Preview deploy verified: jambutter@$expected_version"
