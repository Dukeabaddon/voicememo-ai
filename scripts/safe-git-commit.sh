#!/usr/bin/env bash
# Commit without Cursor co-author injection (uses commit-tree, skips prepare hooks that Cursor may bypass).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"commit message\" [paths...]" >&2
  exit 1
fi

MSG="$1"
shift
[ $# -gt 0 ] && git add "$@" || git add -A

if git diff --cached --quiet; then
  echo "Nothing staged." >&2
  exit 1
fi

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Aaron Mecate}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-aaronmecate182@gmail.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-Aaron Mecate}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-aaronmecate182@gmail.com}"

TREE=$(git write-tree)
PARENT=$(git rev-parse HEAD 2>/dev/null || true)
if [ -n "$PARENT" ]; then
  NEW=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
else
  NEW=$(git commit-tree "$TREE" -m "$MSG")
fi
git reset --hard "$NEW"

if git log -1 --format=%B | grep -qi 'co-authored-by:.*cursor'; then
  echo "ERROR: commit still contains Cursor co-author." >&2
  exit 1
fi

echo "Committed: $(git rev-parse --short HEAD)"
