# hooks/

Optional Claude Code hooks supporting the personal-state workflow.

## personal-state-uncommitted-warn.cjs

Stop hook (advisory). Warns at end of each session if your Layer 2 state repo has
uncommitted changes. Non-blocking — never exits non-zero.

### Install

```sh
cp hooks/personal-state-uncommitted-warn.cjs ~/.claude/hooks/
```

Set the env var (e.g. in `~/.bashrc` / `~/.zshrc` / Windows env):

```sh
export CLAUDE_PERSONAL_STATE_REPO="/absolute/path/to/your/state-repo"
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "type": "command", "command": "node ~/.claude/hooks/personal-state-uncommitted-warn.cjs" }
    ]
  }
}
```

### Bypass

`export CLAUDE_PERSONAL_STATE_WARN_OFF=1`
