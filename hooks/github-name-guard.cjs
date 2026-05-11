#!/usr/bin/env node
// req-ok: user explicitly requested 汎用ハーネス deployment of this hook (Codex DA-approved design); core file already implemented + tested locally, this is the generic copy for the public template repo
// github-name-guard.cjs — PreToolUse hook for Claude Code
//
// Blocks `gh issue / pr / api` and `curl api.github.com` commands when the
// body content contains personal names. Designed to enforce the common
// content policy: "GitHub Issues/PRs MUST NOT contain personal names — use
// roles (e.g. クライアント / 担当者 / 設計者) instead."
//
// Why this hook exists:
//   Self-review prompts are unreliable for content compliance. Even when an
//   in-context rule says "review for personal names before posting," LLM
//   agents routinely copy author / timestamp / mention patterns from source
//   material (Slack threads, emails, meeting notes) directly into GitHub
//   comments. See Huang et al. (arXiv 2310.01798) and Kamoi et al. (TACL)
//   for evidence that intrinsic self-correction fails without external
//   feedback. A deterministic PreToolUse gate prevents the violation at
//   the tool boundary, where it actually matters.
//
// Detection patterns (Unicode regex):
//   - JA_HONORIFIC:        kanji/kana/Latin name + 様/氏/さん/君/くん/ちゃん/殿
//   - SLACK_MENTION:       @username (Slack/GitHub style)
//   - SLACK_ARROW_CITATION: "(name_a → name_b M/D HH:MM)" Slack-style attribution
//   - JP_QUOTE_ATTRIBUTION: "name「quoted text」" at line start
//
// Body extraction sources:
//   --body / -b (inline string)
//   --body-file <path>
//   -F body=@<path> / --field body=@<path> / --raw-field body=@<path>
//   -F body="..." / -f body="..." / --field body="..."
//   <<EOF ... EOF heredoc
//
// Behavior:
//   - Findings present → exit 2 with stderr guidance (blocks the tool call)
//   - Body file referenced but unreadable → fail closed (exit 2)
//   - No trigger pattern match → exit 0 (pass through)
//
// Override:
//   CLAUDE_GH_NAME_GUARD_OFF=1   (skip the check entirely)
//
// Customize allowlist:
//   Edit ALLOW_TERMS below to add your organization / tool / role vocabulary,
//   or set CLAUDE_GH_NAME_GUARD_ALLOWLIST_FILE=<path> to load extras from
//   a newline-separated text file (# comments supported).
//
// Audit trail:
//   ~/.claude/logs/gh-name-guard/YYYY-MM-DD.jsonl
//   Stored as hashed snippets and source labels; raw names are not persisted.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOG_DIR = path.join(os.homedir(), '.claude', 'logs', 'gh-name-guard');

const TRIGGER_PATTERNS = [
  /\bgh\s+issue\s+(comment|create|edit)\b/,
  /\bgh\s+pr\s+(comment|create|edit|review)\b/,
  /\bgh\s+api\s+[^|;&]*\/(issues|pulls)\b/,
  /\bcurl\s+[^|;&]*api\.github\.com\/repos\/[^/]+\/[^/]+\/(issues|pulls)\b/,
];

const JA_HONORIFIC = /(?<![\p{L}\p{N}_])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-zー・]{2,20})\s*(様|氏|さん|君|くん|ちゃん|殿)(?![\p{L}\p{N}_])/gu;
const SLACK_MENTION = /(?<![\w])@[A-Za-z][A-Za-z0-9._-]{2,30}\b/g;
const SLACK_ARROW_CITATION = /\(?\s*([^()\n│]{2,40})\s*→\s*([^()\n│]{2,40})\s+\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*\)?/g;
const JP_QUOTE_ATTRIBUTION = /(?:^|\n)\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]{2,15})\s*「[^」]{4,}」/gu;

// Default allowlist: role terms + common tool/org names.
// Customize for your project (org / team / tool / vendor vocabulary).
const ALLOW_TERMS = new Set([
  // JA role / generic-reference terms (precede 様/氏/さん without being a personal name)
  'クライアント', '担当者', '設計者', '開発者', 'リード', 'リーダー', 'マネージャー',
  '営業', 'CS', 'PM', 'PO', 'QA', 'レビュアー', '管理者', 'デザイナー',
  'エンジニア', 'ユーザー', 'お客', 'お客様', '先方', '弊社', '貴社', '御社',
  '担当', '責任者', '関係者', '社内', '社外', '担当チーム', 'チーム',
  '皆様', '各位', '関係各位',
  // Common tools / orgs / vendors
  'Slack', 'GitHub', 'Claude', 'Salesforce', 'Anthropic', 'OpenAI',
  'AWS', 'Codex', 'Gemini', 'Cursor', 'Devin', 'Aider', 'Microsoft', 'Google',
  'Apple', 'Meta', 'NVIDIA', 'Vercel', 'Modal', 'Sonnet', 'Haiku', 'Opus',
]);

(function loadExtraAllowlist() {
  const extraFile = process.env.CLAUDE_GH_NAME_GUARD_ALLOWLIST_FILE;
  if (!extraFile) return;
  try {
    const expanded = extraFile.replace(/^~/, os.homedir());
    const text = fs.readFileSync(expanded, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) ALLOW_TERMS.add(t);
    }
  } catch (_) { /* missing extra file is fine */ }
})();

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

function appendAudit(record) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `${day}.jsonl`), JSON.stringify(record) + '\n');
  } catch (_) { /* log failure is non-fatal */ }
}

function sha(s) {
  return 'sha256:' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function readFileSafe(p) {
  try {
    const expanded = p.replace(/^~/, os.homedir());
    return fs.readFileSync(expanded, 'utf8');
  } catch (_) {
    return null;
  }
}

function extractBodySources(cmd) {
  const out = [];
  for (const m of cmd.matchAll(/--body-file[=\s]+["']?([^"'\s]+)["']?/g)) {
    const c = readFileSafe(m[1]);
    out.push({ source: `--body-file ${m[1]}`, content: c, readable: c !== null });
  }
  for (const m of cmd.matchAll(/(?:-F|--field|--raw-field)\s+body=@["']?([^"'\s]+)["']?/g)) {
    const c = readFileSafe(m[1]);
    out.push({ source: `body=@${m[1]}`, content: c, readable: c !== null });
  }
  for (const m of cmd.matchAll(/(?:-f|-F|--field|--raw-field)\s+body=(?!@)(["'])([\s\S]*?)\1/g)) {
    out.push({ source: 'body=<inline>', content: m[2], readable: true });
  }
  for (const m of cmd.matchAll(/(?:--body|-b)(?!-)\s+(["'])([\s\S]*?)\1/g)) {
    out.push({ source: '--body <inline>', content: m[2], readable: true });
  }
  for (const m of cmd.matchAll(/<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1/g)) {
    out.push({ source: `<<${m[1]} heredoc`, content: m[2], readable: true });
  }
  return out;
}

function isAllowed(name) {
  return ALLOW_TERMS.has((name || '').trim());
}

function scanContent(content, sourceLabel) {
  const findings = [];
  for (const m of content.matchAll(JA_HONORIFIC)) {
    if (isAllowed(m[1])) continue;
    findings.push({ type: 'JA_HONORIFIC', sample: m[0].slice(0, 60), hash: sha(m[0]), source: sourceLabel });
  }
  for (const m of content.matchAll(SLACK_MENTION)) {
    findings.push({ type: 'SLACK_MENTION', sample: m[0].slice(0, 60), hash: sha(m[0]), source: sourceLabel });
  }
  for (const m of content.matchAll(SLACK_ARROW_CITATION)) {
    findings.push({ type: 'SLACK_ARROW_CITATION', sample: m[0].trim().slice(0, 80), hash: sha(m[0]), source: sourceLabel });
  }
  for (const m of content.matchAll(JP_QUOTE_ATTRIBUTION)) {
    if (isAllowed(m[1])) continue;
    findings.push({ type: 'JP_QUOTE_ATTRIBUTION', sample: m[0].trim().slice(0, 80), hash: sha(m[0]), source: sourceLabel });
  }
  return findings;
}

async function main() {
  if (process.env.CLAUDE_GH_NAME_GUARD_OFF === '1') process.exit(0);
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch (_) { process.exit(0); }
  if (input.tool_name !== 'Bash') process.exit(0);
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd) process.exit(0);
  if (!TRIGGER_PATTERNS.some((re) => re.test(cmd))) process.exit(0);

  const bodies = extractBodySources(cmd);
  if (bodies.length === 0) process.exit(0);

  const unreadable = bodies.filter((b) => !b.readable);
  if (unreadable.length > 0) {
    process.stderr.write(
      `[gh-name-guard] BLOCKED: body file unreadable, cannot scan:\n` +
      unreadable.map((b) => `  - ${b.source}`).join('\n') + '\n' +
      `Provide a readable body file or inline body. Override: CLAUDE_GH_NAME_GUARD_OFF=1\n`
    );
    appendAudit({ ts: new Date().toISOString(), decision: 'blocked', reason: 'unreadable_body', sources: unreadable.map((b) => b.source) });
    process.exit(2);
  }

  const findings = [];
  for (const b of bodies) findings.push(...scanContent(b.content, b.source));
  if (findings.length === 0) process.exit(0);

  const out =
    `[gh-name-guard] BLOCKED: personal name pattern(s) detected in GitHub Issue/PR body.\n` +
    `Findings (${findings.length}):\n` +
    findings.slice(0, 10).map((f) => `  - [${f.type}] ${f.source}: "${f.sample}"`).join('\n') + '\n' +
    `Suggested replacements:\n` +
    `  "person 様/氏/さん" → "クライアント" / "担当者" / "設計者" (role)\n` +
    `  "Slack (person)" → "Slack (クライアント)"\n` +
    `  "(name_a → name_b M/D HH:MM)" → "(Slack やりとり)"\n` +
    `  "name「quoted」" → "クライアント「quoted」" or drop attribution\n` +
    `Override (rare, audited): CLAUDE_GH_NAME_GUARD_OFF=1\n` +
    `Audit log: ~/.claude/logs/gh-name-guard/YYYY-MM-DD.jsonl\n`;

  process.stderr.write(out);
  appendAudit({
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    decision: 'blocked',
    findings: findings.slice(0, 10),
  });
  process.exit(2);
}

main();
