// MIT and ISC require their copyright notice to travel with copies and Apache-2.0 requires a copy of the licence, but a bundler strips comments, so the built app satisfies none of that on its own.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i;

// npm hoists, but a nested copy can be a different version under a different licence, so walk up the way Node's own resolution does.
function findPackageDir(name, fromDir) {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

const readManifest = (dir) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

function licenceText(dir) {
  const file = readdirSync(dir).find((entry) => LICENCE_FILE.test(entry));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
}

// The part every MIT licence shares, for code below that ships without its own licence file; each entry supplies its own copyright line.
const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// MIT code that a dependency copies into its own files, so no package.json names it for the walk below to find. Each is recognised by the credit it ships with: an upgrade that drops the code drops its entry, and one that keeps the code but changes the credit fails the build until this list is updated.
const VENDORED_MIT_CODE = [
  {
    name: "core-js",
    homepage: "https://github.com/zloirock/core-js",
    // pdf.js's legacy build carries core-js's polyfills, with the version record they keep at run time.
    host: "pdfjs-dist",
    files: [
      "legacy/build/pdf.mjs",
      "legacy/build/pdf.worker.mjs",
      "legacy/web/pdf_viewer.mjs",
    ],
    marker: "__core-js_shared__",
    credit:
      /version: ['"]([\d.]+)['"][\s\S]{0,200}?copyright: ['"]©\s*([^'"]+?)\.\s*All rights reserved\./,
  },
  {
    name: "base64-arraybuffer",
    homepage: "https://github.com/niklasvh/base64-arraybuffer",
    // pdf-lib and @pdf-lib/standard-fonts each copy its encoder; one credit covers both.
    host: "pdf-lib",
    files: ["es/utils/base64.js"],
    marker: "base64-arraybuffer",
    credit: /Copyright \(c\) (\d{4} [^\n]+)/,
  },
  {
    name: "pdfkit (SVG path parser)",
    homepage: "https://github.com/foliojs/pdfkit",
    host: "pdf-lib",
    files: ["es/api/svgPath.js"],
    marker: "pdfkit",
    credit: /pdfkit Copyright \(c\) (\d{4} [^\n]+)/,
  },
];

function collectVendoredMitCode(repoRoot, collected, missing) {
  for (const vendored of VENDORED_MIT_CODE) {
    const hostDir = findPackageDir(vendored.host, repoRoot);
    if (!hostDir) {
      continue;
    }
    const host = readManifest(hostDir);
    for (const file of vendored.files) {
      const path = join(hostDir, file);
      const source = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (!source.includes(vendored.marker)) {
        continue;
      }
      const credit = vendored.credit.exec(source);
      if (!credit) {
        missing.push(
          `${vendored.name} (inside ${host.name}/${file}, whose credit no longer reads as expected)`,
        );
        continue;
      }
      // core-js's record gives a version; the others are named by where they were copied.
      const [version, copyright] =
        credit.length > 2 ? [credit[1], credit[2]] : [null, credit[1]];
      const label = version
        ? `${vendored.name}@${version} (inside ${host.name}@${host.version})`
        : `${vendored.name} (inside ${host.name}@${host.version})`;
      collected.set(label, {
        name: vendored.name,
        version,
        label,
        licence: "MIT",
        homepage: vendored.homepage,
        text: `Copyright (c) ${copyright}\n\n${MIT_PERMISSION}`,
      });
    }
  }
}

// The fonts, character maps, colour profile and image decoders pdf.js loads at run time ship beside their own licence files (scripts/prepare-renderer-assets.mjs copies both), and are reproduced here so every licence can be read in one place.
export function collectDataLicences(pdfjsDir, assetDirs) {
  return assetDirs.flatMap((assetDir) =>
    readdirSync(join(pdfjsDir, assetDir))
      .filter((entry) => /^licen[cs]e/i.test(entry))
      .sort()
      .map((entry) => ({
        path: `${assetDir}/${entry}`,
        text: readFileSync(join(pdfjsDir, assetDir, entry), "utf8").trim(),
      })),
  );
}

const entryTitle = (entry) => entry.label ?? `${entry.name}@${entry.version}`;

function licenceName(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  }
  return null;
}

// The `dependencies` tree only: devDependencies never reach a user, and the one optionalDependency is @napi-rs/canvas, which pdf.js reaches through createRequire, so the specifier is bundled but the package's code is not.
export function collectThirdPartyPackages(repoRoot) {
  const collected = new Map();
  const missing = [];

  const collect = (name, fromDir) => {
    const dir = findPackageDir(name, fromDir);
    if (!dir) {
      missing.push(`${name} (could not be resolved from ${fromDir})`);
      return;
    }

    const manifest = readManifest(dir);
    const key = `${manifest.name}@${manifest.version}`;
    if (collected.has(key)) {
      return;
    }

    const text = licenceText(dir);
    const licence = licenceName(manifest);
    if (!text && !licence) {
      missing.push(`${key} (no licence file and no license field)`);
    }

    const repository =
      typeof manifest.repository === "string"
        ? manifest.repository
        : manifest.repository?.url;

    collected.set(key, {
      name: manifest.name,
      version: manifest.version,
      licence,
      homepage: manifest.homepage ?? repository ?? null,
      text,
    });

    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      collect(dependency, dir);
    }
  };

  const root = readManifest(repoRoot);
  for (const dependency of Object.keys(root.dependencies ?? {})) {
    collect(dependency, repoRoot);
  }
  collectVendoredMitCode(repoRoot, collected, missing);

  // Sorted so a rebuild that changes nothing produces an identical file.
  const packages = [...collected.values()].sort((left, right) =>
    entryTitle(left).localeCompare(entryTitle(right)),
  );

  return { packages, missing };
}

// Licence texts go in fenced blocks so their own wrapping survives.
export function renderNotices(projectName, packages, dataLicences = []) {
  const header = [
    `# ${projectName} - third-party notices`,
    "",
    "This application bundles the open-source packages listed below. Each is",
    "reproduced with its own licence text, as those licences require. Code a",
    "package carries inside its own files, under its own licence, is listed",
    "on its own.",
    "",
    "Generated by `scripts/prepare-renderer-assets.mjs` from the production",
    "dependency tree. Build tooling is not distributed and is not listed here;",
    "`workbox-precaching` is a production dependency because its code ships,",
    "inside the service worker.",
    "",
    `## ${packages.length} packages`,
    "",
    ...packages.map(
      (entry) => `- ${entryTitle(entry)} (${entry.licence ?? "see text"})`,
    ),
  ].join("\n");

  const body = packages
    .map((entry) =>
      [
        `## ${entryTitle(entry)}`,
        "",
        entry.licence ? `Licence: ${entry.licence}` : null,
        entry.homepage
          ? `Source: <${entry.homepage.replace(/^git\+/, "")}>`
          : null,
        "",
        "```",
        entry.text ?? `(no licence file shipped; declared as ${entry.licence})`,
        "```",
      ]
        .filter((line) => line !== null)
        .join("\n"),
    )
    .join("\n\n");

  const data = dataLicences
    .map(({ path, text }) =>
      [`### pdfjs-dist/${path}`, "", "```", text, "```"].join("\n"),
    )
    .join("\n\n");

  return data
    ? `${header}\n\n${body}\n\n## pdf.js data files\n\nThe fonts, character maps, colour profile and image decoders pdf.js loads\nat run time, each under its own licence.\n\n${data}\n`
    : `${header}\n\n${body}\n`;
}
