#!/usr/bin/env bash
# One-time per clone: local git identity + block Cursor co-author hooks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git config --local core.hooksPath .githooks
git config --local user.name "Aaron Mecate"
git config --local user.email "aaronmecate182@gmail.com"

chmod +x .githooks/commit-msg .githooks/prepare-commit-msg

# Global identity (only set if missing — never overwrite existing)
if [ -z "$(git config --global user.name 2>/dev/null)" ]; then
  git config --global user.name "Aaron Mecate"
  echo "SET: global user.name"
fi
if [ -z "$(git config --global user.email 2>/dev/null)" ]; then
  git config --global user.email "aaronmecate182@gmail.com"
  echo "SET: global user.email"
fi

echo "OK: core.hooksPath=.githooks (replaces .git/hooks for this repo)"
echo "OK: hooks: prepare-commit-msg (strip), commit-msg (block)"
echo "OK: user.name=$(git config --local user.name)"
echo "OK: user.email=$(git config --local user.email)"
