# Git attribution — Cursor co-author prevention

## Root cause

**Cursor IDE / Agent** can append this trailer when it runs `git commit`:

```text
Co-authored-by: Cursor <cursoragent@cursor.com>
```

GitHub maps that email to the **cursoragent** account → shows a second **Contributor** even when you are the only author.

This is **not** from VoiceMemo app code, MCP, CI, or repo hooks. It is injected by **Cursor’s Attribution** feature at commit time.

## What we fixed in this repo

| Item | Purpose |
|------|---------|
| `.githooks/commit-msg` | Rejects commits that still contain a Cursor co-author line |
| `scripts/setup-git-hooks.sh` | Sets `core.hooksPath`, local `user.name` / `user.email` |
| `scripts/safe-git-commit.sh` | Commits via `git commit-tree` (Cursor cannot append trailers) |
| `.cursorrules` | Tells agents not to add attribution |

After clone:

```bash
./scripts/setup-git-hooks.sh
```

## Cursor settings (you)

1. **Cursor Settings → Agents → Attribution → OFF**
2. CLI (if you use `cursor` CLI), create `~/.cursor/cli-config.json`:

```json
{
  "commitAttribution": false,
  "prAttribution": false
}
```

3. Restart Cursor.

## If GitHub still shows `cursoragent`

Commits on `main` are already clean. The sidebar list is **cached** by GitHub.

**There is no “remove contributor” button** in the repo UI.

Options:

1. Wait 24–72h after the latest force-push.
2. [GitHub Support](https://support.github.com/contact?tags=rr-remove-data) — ask to refresh contributor cache for `Dukeabaddon/voicememo-ai`.
3. **Recreate repo** (same name, empty) and push once — clears the graph immediately (loses stars/issues).

## Verify

```bash
git log -1 --format=%B | grep -i cursor || echo "clean"
curl -s https://api.github.com/repos/Dukeabaddon/voicememo-ai/contributors | grep login
```

Only `Dukeabaddon` should appear when history is clean.
