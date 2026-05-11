#!/usr/bin/env node
// github-name-guard.cjs — PreToolUse hook for Claude Code
//
// Blocks `gh issue / pr / api` and `curl api.github.com` commands when the
// body content contains personal-name patterns. Designed to enforce the
// common content policy: "GitHub Issues/PRs MUST NOT contain personal names
// — use roles (e.g. クライアント / 担当者 / 設計者) instead."
//
// Why this hook exists:
//   In-context content policies (system prompt rules) are unreliable on their
//   own. LLM agents in transcription mode routinely copy author / timestamp /
//   mention patterns from source material (Slack threads, meeting notes)
//   directly into GitHub comments. Self-review fails because the same model
//   that produced the violation runs the review. See Huang et al. (arXiv
//   2310.01798) and Kamoi et al. (TACL) on the unreliability of intrinsic
//   self-correction. A deterministic gate at the tool boundary is required.
//
// Architecture:
//   - PreToolUse on Bash (this hook)
//   - Trigger: command matches GitHub-writing patterns
//   - Extract body from --body / --body-file / -F body=@ / -f body= / heredoc
//     (with quoted-body range masking to avoid false positives from inner
//     documentation that mentions the body extraction syntax)
//   - Regex scan with JA + EN patterns, role/tool allowlist
//   - Skip findings inside markdown backtick code spans (documentation examples)
//   - exit 2 on findings (blocks with stderr feedback)
//   - Audit JSONL with hashed snippets
//   - Override: CLAUDE_GH_NAME_GUARD_OFF=1
//
// Customize allowlist:
//   Edit ALLOW_TERMS below for project / org / tool vocabulary, or set
//   CLAUDE_GH_NAME_GUARD_ALLOWLIST_FILE=<path> to load extras from a
//   newline-separated file (# comments supported).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const LOG_DIR = path.join(os.homedir(), '.claude', 'logs', 'gh-name-guard');

// --- GitHub-writing command triggers ---
const TRIGGER_PATTERNS = [
  /\bgh\s+issue\s+(comment|create|edit)\b/,
  /\bgh\s+pr\s+(comment|create|edit|review)\b/,
  /\bgh\s+api\s+[^|;&]*\/(issues|pulls)\b/,
  /\bcurl\s+[^|;&]*api\.github\.com\/repos\/[^/]+\/[^/]+\/(issues|pulls)\b/,
];

// --- Personal-name detection regex (Unicode mode) ---
const JA_HONORIFIC = /(?<![\p{L}\p{N}_])([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-zー・]{2,20})\s*(様|氏|さん|君|くん|ちゃん|殿)(?![\p{L}\p{N}_])/gu;
const SLACK_MENTION = /(?<![\w])@[A-Za-z][A-Za-z0-9._-]{2,30}\b/g;
const SLACK_ARROW_CITATION = /\(?\s*([^()\n│]{2,40})\s*→\s*([^()\n│]{2,40})\s+\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*\)?/g;
const JP_QUOTE_ATTRIBUTION = /(?:^|\n)\s*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]{2,15})\s*「[^」]{4,}」/gu;

// --- Default allowlist (role terms + common tools/orgs) ---
// Customize for your project / org / vendor vocabulary.
const ALLOW_TERMS = new Set([
  // JA role / generic-reference terms
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

// Optional extension from external file
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

function isPlaceholderPath(p) {
  return /[<>\[\]{}]/.test(p) || p === '...' || p === 'path';
}

function extractBodySources(cmd) {
  const out = [];
  // Extract --body / -b / heredoc / -F body=<inline> FIRST and mask those ranges
  // so that body=@<path> patterns mentioned INSIDE the body (as documentation)
  // are not re-interpreted as actual flag arguments.
  const masked = cmd.split('');
  function mark(start, end) { for (let i = start; i < end && i < masked.length; i++) masked[i] = '\0'; }

  for (const m of cmd.matchAll(/(?:--body|-b)(?!-)\s+(["'])([\s\S]*?)\1/g)) {
    out.push({ source: '--body <inline>', content: m[2], readable: true });
    mark(m.index, m.index + m[0].length);
  }
  for (const m of cmd.matchAll(/<<\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1/g)) {
    out.push({ source: `<<${m[1]} heredoc`, content: m[2], readable: true });
    mark(m.index, m.index + m[0].length);
  }
  for (const m of cmd.matchAll(/(?:-f|-F|--field|--raw-field)\s+body=(?!@)(["'])([\s\S]*?)\1/g)) {
    out.push({ source: 'body=<inline>', content: m[2], readable: true });
    mark(m.index, m.index + m[0].length);
  }

  const cmdMasked = masked.join('');
  for (const m of cmdMasked.matchAll(/--body-file[=\s]+["']?([^"'\s\0]+)["']?/g)) {
    if (isPlaceholderPath(m[1])) continue;
    const c = readFileSafe(m[1]);
    out.push({ source: `--body-file ${m[1]}`, content: c, readable: c !== null });
  }
  for (const m of cmdMasked.matchAll(/(?:-F|--field|--raw-field)\s+body=@["']?([^"'\s\0]+)["']?/g)) {
    if (isPlaceholderPath(m[1])) continue;
    const c = readFileSafe(m[1]);
    out.push({ source: `body=@${m[1]}`, content: c, readable: c !== null });
  }
  return out;
}

function isAllowed(name) {
  return ALLOW_TERMS.has((name || '').trim());
}

// Find markdown backtick code spans (triple + single) so we can skip findings
// that appear inside them — those are typically documentation examples, not
// actual personal-name references in the comment body.
function findBacktickRanges(content) {
  const ranges = [];
  let m;
  const blockRe = /```[\s\S]*?```/g;
  while ((m = blockRe.exec(content)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const spanRe = /`[^`\n]+`/g;
  while ((m = spanRe.exec(content)) !== null) {
    if (ranges.some(([s, e]) => m.index >= s && m.index < e)) continue;
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInside(idx, ranges) {
  return ranges.some(([s, e]) => idx >= s && idx < e);
}

function scanContent(content, sourceLabel) {
  const findings = [];
  const codeRanges = findBacktickRanges(content);

  for (const m of content.matchAll(JA_HONORIFIC)) {
    if (isAllowed(m[1])) continue;
    if (isInside(m.index, codeRanges)) continue;
    findings.push({ type: 'JA_HONORIFIC', sample: m[0].slice(0, 60), hash: sha(m[0]), source: sourceLabel });
  }
  for (const m of content.matchAll(SLACK_MENTION)) {
    if (isInside(m.index, codeRanges)) continue;
    findings.push({ type: 'SLACK_MENTION', sample: m[0].slice(0, 60), hash: sha(m[0]), source: sourceLabel });
  }
  for (const m of content.matchAll(SLACK_ARROW_CITATION)) {
    if (isInside(m.index, codeRanges)) continue;
    findings.push({ type: 'SLACK_ARROW_CITATION', sample: m[0].trim().slice(0, 80), hash: sha(m[0]), source: sourceLabel });
  }
  for (const m of content.matchAll(JP_QUOTE_ATTRIBUTION)) {
    if (isAllowed(m[1])) continue;
    if (isInside(m.index, codeRanges)) continue;
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
    `Rule: output-quality.md "GitHub Issues/PRs (STRICT): NEVER include personal names. Use roles."\n` +
    `Findings (${findings.length}):\n` +
    findings.slice(0, 10).map((f) => `  - [${f.type}] ${f.source}: "${f.sample}"`).join('\n') + '\n' +
    `Suggested replacements:\n` +
    `  "person 様/氏/さん" → "クライアント" / "担当者" / "設計者"\n` +
    `  "Slack (person)" → "Slack (クライアント)"\n` +
    `  "(person_a → person_b 5/X 11:25)" → "(Slack やりとり)"\n` +
    `  "person「quoted」" → "クライアント「quoted」" or drop attribution\n` +
    `Override (rare, audited): CLAUDE_GH_NAME_GUARD_OFF=1\n` +
    `Audit: ~/.claude/logs/gh-name-guard/YYYY-MM-DD.jsonl\n`;

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