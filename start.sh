#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
exec node src/index.js "$@"
