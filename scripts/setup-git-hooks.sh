#!/usr/bin/env bash
# One-time per clone: local git identity + block Cursor co-author hooks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git config --local core.hooksPath .githooks
git config --local user.name "Aaron Mecate"
git config --local user.email "aaronmecate182@gmail.com"

chmod +x .githooks/commit-msg

echo "OK: core.hooksPath=.githooks"
echo "OK: user.name=$(git config --local user.name)"
echo "OK: user.email=$(git config --local user.email)"
