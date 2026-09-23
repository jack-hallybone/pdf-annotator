// `pdfjs-dist` ships its worker with a `sourceMappingURL` for a map it does not
// ship and Vite copies the asset through verbatim, so the references naming a
// file the build did not produce are stripped here, before the digest stamper,
// which would otherwise pin bytes this then rewrites.
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist");

const MAPPABLE_ASSET = /\.(?:[cm]?js|css)$/;

// Both spellings, anchored to a whole line so a string in the code that
// happens to contain the word is not matched.
const SOURCE_MAP_REFERENCE =
  /^[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=(\S+?)[ \t]*(?:\*\/)?[ \t]*$/gm;

export function builtFiles(dir = outDir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const where = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? builtFiles(join(dir, entry.name), where)
      : [where];
  });
}

// `inline` is a `data:` map - sources inside the artifact.
export function sourceMapReferences(outputRoot, file) {
  const path = join(outputRoot, file);
  if (!MAPPABLE_ASSET.test(file) || statSync(path).size === 0) {
    return [];
  }

  const text = readFileSync(path, "utf8");
  SOURCE_MAP_REFERENCE.lastIndex = 0;
  return Array.from(text.matchAll(SOURCE_MAP_REFERENCE), (match) => {
    const target = match[1];
    const inline = target.startsWith("data:");
    return {
      file,
      inline,
      line: match[0],
      shipped:
        !inline &&
        !/^[a-z]+:/i.test(target) &&
        existsSync(resolve(dirname(path), target)),
      target,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let stripped = 0;
  for (const file of builtFiles()) {
    const dangling = sourceMapReferences(outDir, file).filter(
      (reference) => !reference.inline && !reference.shipped,
    );
    if (dangling.length === 0) {
      continue;
    }

    const path = join(outDir, file);
    let text = readFileSync(path, "utf8");
    for (const reference of dangling) {
      text = text
        .replace(`${reference.line}\n`, "")
        .replace(reference.line, "");
      stripped += 1;
      console.log(
        `Dangling source map: ${relative(root, path)} -> ${reference.target} (removed)`,
      );
    }
    writeFileSync(path, text);
  }
  console.log(`Source maps: ${stripped} dangling reference(s) removed.`);
}
