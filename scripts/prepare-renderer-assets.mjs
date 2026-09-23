import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectThirdPartyPackages,
  renderNotices,
} from "./thirdPartyNotices.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedRoot = join(root, ".generated", "renderer-assets");
const browserAssetsRoot = join(root, "src", "browserapp", "assets");
const pdfjsSourceRoot = join(root, "node_modules", "pdfjs-dist");
const pdfjsTargetRoot = join(generatedRoot, "pdfjs");
const assetDirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
const licenseFiles = ["LICENSE", "NOTICE"];
const unusedWasmAssets = ["quickjs-eval.js", "quickjs-eval.wasm"];

const bundledByThePage = pageReferencedAssets();

removePath(generatedRoot);
mkdirSync(generatedRoot, { recursive: true });
cpSync(browserAssetsRoot, generatedRoot, {
  recursive: true,
  filter: (source) => !bundledByThePage.has(basename(source)),
});
mkdirSync(pdfjsTargetRoot, { recursive: true });

for (const assetDir of assetDirs) {
  const source = join(pdfjsSourceRoot, assetDir);
  const target = join(pdfjsTargetRoot, assetDir);

  if (!existsSync(source)) {
    throw new Error(`Missing PDF.js asset directory: ${source}`);
  }

  removePath(target);
  cpSync(source, target, { recursive: true });
}

for (const file of licenseFiles) {
  const source = join(pdfjsSourceRoot, file);
  const target = join(pdfjsTargetRoot, file);

  if (existsSync(source)) {
    cpSync(source, target);
  } else {
    removePath(target);
  }
}

for (const asset of unusedWasmAssets) {
  removePath(join(pdfjsTargetRoot, "wasm", asset));
}

// PDF.js builds each of these URLs by appending a filename to a base we hand
// it, so the files cannot carry a content hash the way a bundled asset does.
// Hashing the directory puts the identity in the path instead, and it only
// changes when the assets do, so a browser keeps them across releases.
const digest = hashTree(pdfjsTargetRoot);
const pdfjsAssetDir = `pdfjs-${digest}`;
renameSync(pdfjsTargetRoot, join(generatedRoot, pdfjsAssetDir));

fillManifestProductName();
writeThirdPartyNotices();

// Paths as well as bytes: moving a file changes what PDF.js can fetch while
// leaving the set of bytes identical.
function hashTree(dir) {
  const files = [];
  const walk = (at) => {
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);

  const tree = createHash("sha256");
  for (const file of files.sort()) {
    tree.update(relative(dir, file).split(sep).join("/"));
    tree.update("\0");
    tree.update(createHash("sha256").update(readFileSync(file)).digest());
  }
  // Twelve characters, the length Vite gives its own asset hashes.
  return tree.digest("hex").slice(0, 12);
}

// The display name is declared once, as package.json's `productName`, so the
// committed manifest carries placeholders and this fills them. The service
// worker's cache prefix and the directory-picker and lock ids key off the
// package's `name` instead, because they address a user's stored data.
function fillManifestProductName() {
  const { productName, productShortName } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );

  if (!productName || !productShortName) {
    throw new Error(
      "package.json declares no productName/productShortName; the manifest " +
        "has nowhere to derive its name from.",
    );
  }

  const source = join(browserAssetsRoot, "site.webmanifest");
  const template = readFileSync(source, "utf8");

  // A manifest that stopped carrying the placeholders would be copied through
  // with whatever name was typed into it.
  for (const token of ["%PRODUCT_NAME%", "%PRODUCT_SHORT_NAME%"]) {
    if (!template.includes(token)) {
      throw new Error(
        `${source} no longer contains ${token}, so the display name is not ` +
          "being derived from package.json.",
      );
    }
  }

  const filled = template
    .replaceAll("%PRODUCT_NAME%", productName)
    .replaceAll("%PRODUCT_SHORT_NAME%", productShortName);

  writeFileSync(join(generatedRoot, "site.webmanifest"), filled);
}

// Read out of the page rather than listed here: these travel through the
// module graph, where Vite content-hashes them, so copying them verbatim as
// well would ship a second copy at an identity-free path.
function pageReferencedAssets() {
  const page = readFileSync(join(root, "index.html"), "utf8");
  const names = new Set(
    Array.from(
      page.matchAll(/\/src\/browserapp\/assets\/([\w.-]+)/g),
      (match) => match[1],
    ),
  );
  // A page that referenced none of them would go back to shipping every icon
  // unhashed at the site root.
  if (names.size === 0) {
    throw new Error(
      "index.html references no src/browserapp/assets file, so nothing is " +
        "being content-hashed through the module graph.",
    );
  }
  return names;
}

// Tracked at the repository root and imported from there by the app footer, so
// one file answers both a repository reader and an installed offline copy.
// Regenerated on every build, because a hand-kept one goes stale in silence.
function writeThirdPartyNotices() {
  const { packages, missing } = collectThirdPartyPackages(root);
  // A licence that cannot be found fails the build rather than emitting a
  // notices file with a hole in it.
  if (missing.length > 0) {
    throw new Error(
      `Third-party notices: could not determine a licence for:\n  ` +
        missing.join("\n  "),
    );
  }
  const { name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(
    join(root, "THIRD-PARTY-NOTICES.md"),
    renderNotices(name, packages),
    "utf8",
  );
  console.log(
    `Third-party notices: ${packages.length} packages -> ` +
      `THIRD-PARTY-NOTICES.md`,
  );
}

function removePath(path) {
  rmSync(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 100,
  });
}
