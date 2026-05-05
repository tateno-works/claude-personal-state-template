# policies/ — Architecture Fitness Gate corpus

This directory holds project-agnostic policy files consumed by Claude Code hooks
(e.g. Architecture Fitness Gate, parent-issue-gate). Layout:

```
policies/
├── semgrep/
│   ├── <platform>.yml          # ruleset per platform (Dify, scoring-engine, ...)
│   └── ...
├── tests/
│   └── <platform>/
│       ├── bad/                # fixtures that MUST trigger
│       ├── good/               # fixtures that MUST NOT trigger
│       └── mutants/            # adversarial variants
├── platform-manifest.yml       # platform → ruleset registry
├── exceptions.yml              # per-finding overrides (≤30 days, ≤10 active)
├── integrity.sha256            # sha256 of all .yml + scripts (verified by hooks)
└── README.md                   # this file
```

## Adding a new platform

1. Create `semgrep/<platform>.yml` (rule IDs prefixed `<platform>-*`)
2. Add fixtures under `tests/<platform>/{bad,good,mutants}/`
3. Register in `platform-manifest.yml`
4. Regenerate integrity:

```sh
bash ~/.claude/scripts/policy-integrity-update.sh --yes
```

No hook code changes required.

## Exceptions

Format (each entry):

```yaml
- rule_id: <id>
  file: <path>
  owner: <github handle>
  reason: "<≥20 chars>"
  expires: "YYYY-MM-DD"   # ≤30 days from creation
  context_link: <url>
  finding_sha256: <sha>
```

Caps: ≤10 active, ≤2 new per commit. Hooks block exceeding caps.
