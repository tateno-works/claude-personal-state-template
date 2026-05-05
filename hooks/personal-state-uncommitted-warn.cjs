#!/usr/bin/env node
// personal-state-uncommitted-warn.cjs
// Stop hook: warn (non-blocking) if your personal-state repo has uncommitted changes.
//
// Setup:
//   1. Copy this file to ~/.claude/hooks/  (or symlink from your harness sync dir)
//   2. Set env var:  export CLAUDE_PERSONAL_STATE_REPO="/abs/path/to/your/state-repo"
//   3. Add to settings.json hooks.Stop:
//        { "type": "command", "command": "node ~/.claude/hooks/personal-state-uncommitted-warn.cjs" }
//
// Bypass:  CLAUDE_PERSONAL_STATE_WARN_OFF=1
// Exits 0 always (advisory only).

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.CLAUDE_PERSONAL_STATE_WARN_OFF === '1') process.exit(0);

// Resolution order:
//   1. $CLAUDE_PERSONAL_STATE_REPO (explicit)
//   2. realpath of ~/.claude/policies symlink → its containing repo root
//   3. realpath of ~/.claude/CLAUDE.md (if symlink) → its containing repo root
function resolveRepo() {
  if (process.env.CLAUDE_PERSONAL_STATE_REPO) {
    return process.env.CLAUDE_PERSONAL_STATE_REPO;
  }
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const candidates = [
    path.join(claudeHome, 'policies'),
    path.join(claudeHome, 'CLAUDE.md'),
  ];
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      // Walk up looking for .git
      let dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
      for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch { /* ignore */ }
  }
  return null;
}

const repo = resolveRepo();
if (!repo) process.exit(0); // No state repo configured, skip silently

if (!fs.existsSync(path.join(repo, '.git'))) {
  process.exit(0); // Not a git repo, skip silently
}

let status = '';
try {
  status = execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
} catch {
  process.exit(0); // git unavailable, don't fail the session
}

if (!status) process.exit(0);

const lines = status.split('\n');
const summary = lines.slice(0, 5).join('\n');
const more = lines.length > 5 ? `\n  ... +${lines.length - 5} more` : '';

process.stderr.write(
  `\n[personal-state] ${lines.length} uncommitted change(s) in ${repo}:\n${summary}${more}\n` +
  `  cd "${repo}" && git add -A && git commit && git push\n` +
  `  (silence with CLAUDE_PERSONAL_STATE_WARN_OFF=1)\n`
);
process.exit(0);
