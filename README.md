# claude-personal-state-template

Generic mechanism to keep your Claude Code personal state (`CLAUDE.md`, project `memory/`, `policies/`) in **your own private GitHub repo**, synced across PCs via symlinks/junctions.

## Why

Claude Code's `~/.claude/projects/<auto>/memory/` and `~/.claude/policies/` are PC-local by default. This template lets you:

- Track them in Git (history, diff, review)
- Sync across multiple PCs (clone the private repo on each)
- Keep the *mechanism* generic (this repo, public) and the *content* private (your fork)

## Architecture

```
Layer 1 (this repo, public, generic):
  setup.sh / teardown.sh / templates → reusable by anyone

Layer 2 (your fork, private, personal):
  CLAUDE.md / memory/ / policies/    → your actual content

Each PC:
  ~/.claude/CLAUDE.md           ─┐
  ~/.claude/projects/*/memory   ─┼─ symlinks → Layer 2 repo on disk
  ~/.claude/policies            ─┘
```

## Quick Start

### 1. Create your private state repo

```sh
gh repo create <your-org>/claude-personal-state --private --clone --add-readme
cd claude-personal-state
```

Copy `setup.sh`, `teardown.sh`, `.gitignore`, `CLAUDE.md.template`, `policies-template/`, `memory-template/` from this template repo.

### 2. (Optional) Seed with your existing state

```sh
cp -r ~/.claude/projects/<your-project-dir>/memory ./memory
cp -r ~/.claude/policies ./policies
cp ~/.claude/CLAUDE.md ./CLAUDE.md
git add . && git commit -m "seed: import existing state" && git push
```

### 3. Run setup on each PC

```sh
bash setup.sh --state-repo "$(pwd)" --project-dir "$HOME"
```

Setup will:

1. Back up existing `CLAUDE.md` / `memory/` / `policies/` to `*.bak.<timestamp>`
2. Create symlinks (Linux/macOS) or junctions (Windows) pointing to this repo
3. Verify links resolve

### 4. Edit & commit as usual

```sh
cd <state-repo>
git add memory/feedback_xxx.md
git commit -m "memory: add new feedback"
git push
```

On other PCs: `git pull` and changes appear in `~/.claude/` instantly via the symlink.

## CLI

```
setup.sh [options]
  --state-repo <path>      (required) Absolute path to your Layer 2 repo clone
  --claude-home <path>     (default: $HOME/.claude)
  --project-dir <path>     (default: $HOME) primary working directory whose memory/ to link
  --dry-run                Print actions without executing
  --force                  Overwrite existing symlinks (still backs up real files)

teardown.sh [options]
  --claude-home <path>     (default: $HOME/.claude)
  --project-dir <path>     (default: $HOME)
  --restore-backup         Restore most recent *.bak.* (default: leave unlinked)
```

## OS Support

| OS | Mechanism | Notes |
|---|---|---|
| Linux | `ln -s` | works out of box |
| macOS | `ln -s` | works out of box |
| Windows | `mklink /J` (dirs) / `mklink /H` (files) | run from Git Bash; no admin needed |

## Layer 2 .gitignore

Use the included `.gitignore`. It excludes ephemeral state (`logs/`, `cache/`, `*.log`, `*.bak.*`) but keeps `memory/`, `policies/`, `CLAUDE.md`.

## Stop Hook (recommended)

`hooks/personal-state-uncommitted-warn.cjs` warns at session end if your state repo has uncommitted changes. Install:

```sh
cp hooks/personal-state-uncommitted-warn.cjs ~/.claude/hooks/
# Add to settings.json hooks.Stop array (see hooks/README.md)
export CLAUDE_PERSONAL_STATE_REPO="<absolute path to Layer 2 repo>"
```

## License

MIT
