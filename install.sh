#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install

npm run build
npm link --bin-links=true
command -v ai-quota >/dev/null && echo "✓ $(command -v ai-quota) → $(realpath "$(command -v ai-quota)")"
command -v api-usage >/dev/null && echo "✓ $(command -v api-usage) → $(realpath "$(command -v api-usage)")"
