# Git attribution — Cursor co-author prevention

## Root cause

| Layer | Finding |
|-------|---------|
| **Cursor IDE** | Agents → **Attribution** appends `Co-authored-by: Cursor <cursoragent@cursor.com>` when Cursor runs `git commit`. |
| **Cursor CLI** | `~/.cursor/cli-config.json` → `commitAttribution` / `prAttribution` must be `false`. |
| **GitHub UI** | Contributors sidebar **caches** old co-authors after history rewrite; API may show 1 user while UI still shows 2. |
| **Not caused by** | VoiceMemo code, MCP, CI, npm scripts, or repo `.git/hooks` samples (inactive until `core.hooksPath` is set). |

## Disable in Cursor (required)

Per [disable Cursor attribution guide](https://www.mehmetbaykar.com/posts/how-to-disable-made-with-cursor-attribution/):

1. **Cursor Settings** (not VS Code) → **Agents** → **Attribution**
2. Turn **Commit Attribution** OFF
3. Turn **PR Attribution** OFF
4. Restart Cursor

CLI (`~/.cursor/cli-config.json`):

```json
{
  "commitAttribution": false,
  "prAttribution": false
}
```

Run `cursor /update-cli-config` if you use the CLI.

## Repo hooks (permanent sanitization)

This repo uses **`core.hooksPath=.githooks`** (not `.git/hooks/` — same effect when configured).

| Hook | Role |
|------|------|
| `prepare-commit-msg` | **Strips** `cursoragent@cursor.com`, `Co-authored-by: Cursor`, `Made-with: Cursor` |
| `commit-msg` | **Blocks** commit if any Cursor trailer remains |

After clone:

```bash
./scripts/setup-git-hooks.sh
```

## Git identity

| Scope | Expected |
|-------|----------|
| `user.name` | Aaron Mecate |
| `user.email` | aaronmecate182@gmail.com |
| Cursor identity | **Must not** appear |

## History on `main`

Current `main` has **no** Cursor co-author trailers. Older unreachable commits in **reflog** may still contain them locally; they are **not** on GitHub `main`.

**History rewrite:** only needed if you push old branches/tags with co-authors. Do **not** rewrite without explicit approval. Safer: keep clean `main` + cache refresh below.

## Refresh GitHub contributor cache (no repo delete)

```bash
# From repo root, with gh authenticated:
git branch main-cache-bust
git push origin main-cache-bust
gh repo edit Dukeabaddon/voicememo-ai --default-branch main-cache-bust
sleep 3
gh repo edit Dukeabaddon/voicememo-ai --default-branch main
git push origin --delete main-cache-bust
```

Then hard-refresh the repo page. If `cursoragent` remains, open a [GitHub Support](https://support.github.com/contact?tags=rr-remove-data) ticket for contributor-cache refresh.

## Verify

```bash
git log main --format=%B | grep -iE 'co-authored-by:.*cursor|cursoragent' || echo "history clean"
curl -s https://api.github.com/repos/Dukeabaddon/voicememo-ai/contributors | grep '"login"'
```
