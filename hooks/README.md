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

---

## github-name-guard.cjs

PreToolUse hook (blocking). Scans `gh issue / pr / api` and `curl api.github.com`
commands for personal-name patterns in the body content. Blocks the tool call
(exit 2) with actionable feedback when violations are detected.

### Rationale

In-context content policies like "do not include personal names in GitHub issues"
are unreliable on their own. Even with the rule loaded in every system prompt,
LLM agents routinely copy author / timestamp / mention patterns from source
material (Slack threads, meeting notes) directly into GitHub comments because
"transcription mode" suppresses the rule-check. See Huang et al. (arXiv
2310.01798) and Kamoi et al. (TACL) on the unreliability of intrinsic
self-correction. The fix is a deterministic gate at the tool boundary.

### What it catches

- JA honorific names: `kanji/kana/Latin name + 様/氏/さん/君/くん/ちゃん/殿`
- Slack-style mentions: `@username`
- Slack arrow citations: `(name_a → name_b M/D HH:MM)`
- JA quote attributions: `name「quoted text」` at line start

Body content is extracted from `--body`, `--body-file`, `-F body=@<path>`,
`-f body="..."`, and `<<EOF ... EOF` heredocs. Unreadable body files fail
closed (block with explanation).

### Install

```sh
cp hooks/github-name-guard.cjs ~/.claude/hooks/
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/github-name-guard.cjs" }
        ]
      }
    ]
  }
}
```

(Windows users: substitute `hidden-node.exe` or `node` invocation per your harness.)

### Customize allowlist

Two options:

1. Edit `ALLOW_TERMS` at the top of `github-name-guard.cjs` to add your
   organization, tool, and role vocabulary (companies / vendors / titles
   you commonly reference in GitHub comments).
2. Set an env var pointing to an external file:

   ```sh
   export CLAUDE_GH_NAME_GUARD_ALLOWLIST_FILE=~/.claude/hooks/github-name-allowlist.txt
   ```

   File format: one term per line, `#` for comments.

### Bypass

```sh
export CLAUDE_GH_NAME_GUARD_OFF=1   # disables the hook for the current shell
```

### Audit log

`~/.claude/logs/gh-name-guard/YYYY-MM-DD.jsonl` — one JSONL record per blocked
event with timestamp, session id, source label, decision, and hashed snippets.
Raw names are not persisted.
