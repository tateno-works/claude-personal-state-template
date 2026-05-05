#!/usr/bin/env bash
# teardown.sh — remove symlinks created by setup.sh
# Optionally restore the most recent *.bak.* backup.

set -euo pipefail

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
PROJECT_DIR="${PROJECT_DIR:-$HOME}"
RESTORE_BACKUP=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: teardown.sh [options]

Options:
  --claude-home <path>   (default: \$HOME/.claude)
  --project-dir <path>   (default: \$HOME)
  --restore-backup       Restore most recent *.bak.* (default: leave unlinked)
  --dry-run              Print actions without executing
  -h, --help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --claude-home) CLAUDE_HOME="$2"; shift 2;;
    --project-dir) PROJECT_DIR="$2"; shift 2;;
    --restore-backup) RESTORE_BACKUP=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

case "$(uname -s)" in
  Linux*) OS=linux;;
  Darwin*) OS=macos;;
  MINGW*|MSYS*|CYGWIN*) OS=windows;;
  *) echo "ERROR: unsupported OS" >&2; exit 1;;
esac

encode_project_dir() {
  printf '%s' "$1" | sed 's|[:/\\]|-|g'
}

project_dir_native() {
  if [ "$OS" = windows ]; then
    cygpath -w "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

PROJECT_NAME="$(encode_project_dir "$(project_dir_native "$PROJECT_DIR")")"
MEMORY_DIR="$CLAUDE_HOME/projects/$PROJECT_NAME/memory"

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY: $*"
  else
    eval "$@"
  fi
}

unlink_one() {
  local path="$1"
  local kind="$2"  # file | dir
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    echo "SKIP (missing): $path"
    return
  fi
  if [ -L "$path" ]; then
    echo "UNLINK: $path"
    run "rm -f \"$path\""
  elif [ "$OS" = windows ] && [ "$kind" = dir ] && [ -d "$path" ]; then
    # Junctions appear as dirs but rmdir removes the link only
    echo "UNLINK (junction): $path"
    run "cmd //c \"rmdir \\\"$(cygpath -w "$path")\\\"\""
  else
    echo "SKIP (not a link): $path"
    return
  fi

  if [ "$RESTORE_BACKUP" = 1 ]; then
    local latest
    latest="$(ls -1dt "${path}.bak."* 2>/dev/null | head -n1 || true)"
    if [ -n "$latest" ]; then
      echo "RESTORE: $latest -> $path"
      run "mv \"$latest\" \"$path\""
    fi
  fi
}

unlink_one "$CLAUDE_HOME/CLAUDE.md" file
unlink_one "$MEMORY_DIR" dir
unlink_one "$CLAUDE_HOME/policies" dir

echo "Done."
