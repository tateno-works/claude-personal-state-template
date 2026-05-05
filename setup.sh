#!/usr/bin/env bash
# setup.sh — link your Layer 2 state repo into ~/.claude/
# See README.md for full usage.

set -euo pipefail

STATE_REPO=""
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
PROJECT_DIR="${PROJECT_DIR:-$HOME}"
DRY_RUN=0
FORCE=0

usage() {
  cat <<EOF
Usage: setup.sh --state-repo <path> [options]

Options:
  --state-repo <path>    (required) Absolute path to your Layer 2 repo clone
  --claude-home <path>   (default: \$HOME/.claude)
  --project-dir <path>   (default: \$HOME) primary working dir whose memory/ to link
  --dry-run              Print actions without executing
  --force                Overwrite existing symlinks (still backs up real files)
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --state-repo) STATE_REPO="$2"; shift 2;;
    --claude-home) CLAUDE_HOME="$2"; shift 2;;
    --project-dir) PROJECT_DIR="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --force) FORCE=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1;;
  esac
done

if [ -z "$STATE_REPO" ]; then
  echo "ERROR: --state-repo is required" >&2
  usage
  exit 1
fi

# Normalize to absolute path
STATE_REPO="$(cd "$STATE_REPO" && pwd)"
CLAUDE_HOME="$(cd "$CLAUDE_HOME" 2>/dev/null && pwd || echo "$CLAUDE_HOME")"

# Detect OS
case "$(uname -s)" in
  Linux*) OS=linux;;
  Darwin*) OS=macos;;
  MINGW*|MSYS*|CYGWIN*) OS=windows;;
  *) echo "ERROR: unsupported OS $(uname -s)" >&2; exit 1;;
esac

# Encode project dir to Claude Code's project-name format.
# Claude Code encodes the OS-native absolute path: C:\Users\musta -> C--Users-musta
# Rule: replace : / \ with - (so C:\Users\musta -> C--Users-musta, /Users/foo -> -Users-foo)
encode_project_dir() {
  printf '%s' "$1" | sed 's|[:/\\]|-|g'
}

# On Windows, convert MSYS path (/c/Users/musta) to native (C:\Users\musta) before encoding
project_dir_native() {
  if [ "$OS" = windows ]; then
    cygpath -w "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

PROJECT_NAME="$(encode_project_dir "$(project_dir_native "$PROJECT_DIR")")"
MEMORY_DIR_PARENT="$CLAUDE_HOME/projects/$PROJECT_NAME"

echo "OS:            $OS"
echo "STATE_REPO:    $STATE_REPO"
echo "CLAUDE_HOME:   $CLAUDE_HOME"
echo "PROJECT_DIR:   $PROJECT_DIR"
echo "PROJECT_NAME:  $PROJECT_NAME"
echo "MEMORY_TARGET: $MEMORY_DIR_PARENT/memory"
echo

say() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY: '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# Convert MSYS path to Windows path for cmd /c mklink
to_winpath() {
  if [ "$OS" = windows ]; then
    # /c/Users/foo -> C:\Users\foo
    cygpath -w "$1" 2>/dev/null || printf '%s' "$1" | sed 's|^/\([a-z]\)/|\U\1:\\|; s|/|\\|g'
  else
    printf '%s' "$1"
  fi
}

backup_if_real() {
  local path="$1"
  if [ -L "$path" ]; then
    if [ "$FORCE" = 1 ]; then
      say rm -f "$path"
    else
      echo "SKIP (already symlink): $path  (use --force to overwrite)"
      return 1
    fi
  elif [ -e "$path" ]; then
    local ts
    ts="$(date +%Y%m%d-%H%M%S)"
    local bak="${path}.bak.${ts}"
    echo "BACKUP: $path -> $bak"
    say mv "$path" "$bak"
  fi
  return 0
}

# Run mklink via cmd.exe. Bash arrays preserve backslashes correctly across argv.
mklink_win() {
  local flag="$1" dst_w="$2" src_w="$3"
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY: cmd //c mklink %s %q %q\n' "$flag" "$dst_w" "$src_w"
    return 0
  fi
  cmd //c mklink "$flag" "$dst_w" "$src_w"
}

link_path() {
  local src="$1"   # target inside state repo
  local dst="$2"   # path under CLAUDE_HOME
  local kind="$3"  # file | dir

  if [ ! -e "$src" ]; then
    echo "SKIP (source missing): $src"
    return
  fi

  mkdir -p "$(dirname "$dst")"

  if ! backup_if_real "$dst"; then
    return
  fi

  if [ "$OS" = windows ]; then
    local src_w dst_w flag
    src_w="$(to_winpath "$src")"
    dst_w="$(to_winpath "$dst")"
    if [ "$kind" = dir ]; then
      flag="/J"  # junction (no admin needed)
    else
      flag="/H"  # hard link (no admin needed)
    fi
    mklink_win "$flag" "$dst_w" "$src_w"
  else
    say ln -s "$src" "$dst"
  fi
  echo "LINK: $dst -> $src"
}

# 1. CLAUDE.md (file)
if [ -f "$STATE_REPO/CLAUDE.md" ]; then
  link_path "$STATE_REPO/CLAUDE.md" "$CLAUDE_HOME/CLAUDE.md" file
fi

# 2. memory/ (dir, under projects/<encoded>/)
if [ -d "$STATE_REPO/memory" ]; then
  link_path "$STATE_REPO/memory" "$MEMORY_DIR_PARENT/memory" dir
fi

# 3. policies/ (dir)
if [ -d "$STATE_REPO/policies" ]; then
  link_path "$STATE_REPO/policies" "$CLAUDE_HOME/policies" dir
fi

echo
echo "Done. Verify with:"
echo "  ls -la \"$CLAUDE_HOME/CLAUDE.md\""
echo "  ls -la \"$MEMORY_DIR_PARENT/memory\""
echo "  ls -la \"$CLAUDE_HOME/policies\""
