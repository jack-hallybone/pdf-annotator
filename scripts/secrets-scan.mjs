import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Build output is scanned too, since it ships: verify runs this after the build.
const SKIP = new Set(["node_modules", ".git"]);
const PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{60,})/],
  ["GitLab token", /\bglpat-[\w-]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Slack webhook", /hooks\.slack\.com\/services\/T\w+\/B\w+\/\w+/],
  ["Google API key", /\bAIza[\w-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{24,}/],
  ["OpenAI or Anthropic key", /\bsk-(?:ant|proj)-[\w-]{32,}/],
  ["SendGrid key", /\bSG\.[\w-]{22}\.[\w-]{43}\b/],
  [
    "secret in an env-style assignment",
    /^[ \t]*[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY)[A-Z0-9_]*[ \t]*=[ \t]*\S{8,}/m,
  ],
];

const findings = [];
const scan = (path) => {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(text);
    if (match)
      findings.push(
        `${relative(ROOT, path)}:${text.slice(0, match.index).split("\n").length}: ${kind}`,
      );
  }
};
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !SKIP.has(entry.name)) walk(path);
    else if (entry.isFile()) scan(path);
  }
};

walk(ROOT);
for (const finding of findings) console.error(finding);
if (findings.length) process.exit(1);
console.log("secrets:scan: no credentials found");
