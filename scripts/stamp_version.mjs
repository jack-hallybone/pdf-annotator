/* Copied in, not installed: never edit it in a consuming project, suggest changes only. */

/* Fills every <release-version></release-version> in a page, so a project marks
   where its version belongs by adding one. */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const USAGE = 'usage: node stamp_version.mjs <file.html> ["<version>"]';

/* The commit's own date, so re-running an old commit still dates it, and read
   from the working directory because the staged page is outside the checkout. */
function gitVersion() {
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    }).trim();
  try {
    const date = git(
      "log",
      "-1",
      "--format=%cd",
      "--date=format-local:%Y-%m-%d %H:%M",
    );
    return `v. ${date} UTC · ${git("rev-parse", "--short", "HEAD")}`;
  } catch {
    console.error("no version given, and none could be read from git");
    process.exit(1);
  }
}

/* Absent, not empty: a CI variable that failed to expand must fail here rather
   than fall back to git and stamp a plausible-looking wrong version. */
const argv = process.argv.slice(2);
const [file, given] = argv;
if (!file || (argv.length > 1 && !given.trim())) {
  console.error(USAGE);
  process.exit(1);
}

const version = argv.length > 1 ? given.trim() : gitVersion();

if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
  console.error(`${file}: not a file — has the build run?`);
  process.exit(1);
}

const ANCHOR = /(<release-version[^>]*>)([^<]*)(<\/release-version>)/gi;

/* The version lands in markup, and a project may stamp a tag or branch name. */
const escape = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const html = readFileSync(file, "utf8");
const hits = html.match(ANCHOR)?.length ?? 0;
if (!hits) {
  console.error(`${file}: no <release-version> to stamp`);
  process.exit(1);
}

/* Replaced by function, so a $ in the version stays a $ rather than being read
   as a capture-group reference. */
writeFileSync(
  file,
  html.replace(
    ANCHOR,
    (_match, open, _old, close) => open + escape(version) + close,
  ),
);
console.log(`${file}: stamped ${hits} as "${version}"`);
