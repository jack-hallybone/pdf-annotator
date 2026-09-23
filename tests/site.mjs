// Built here rather than found here: `npm run verify` runs the browser suites
// before the build, and a directory found on disk can be older than the source.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const SITE = join(ROOT, "dist");

const TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

// The returned server's `kill()` refuses every request at the socket, which is
// what a dead network looks like to a service worker.
export async function serveBuiltSite(expect = "index.html") {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  if (!existsSync(join(SITE, expect))) {
    throw new Error(`the build produced no dist/${expect}`);
  }

  let dead = false;
  const site = http.createServer((request, response) => {
    if (dead) {
      request.socket.destroy();
      return;
    }
    const path = decodeURIComponent((request.url ?? "/").split(/[?#]/u, 1)[0]);
    const file = resolve(
      SITE,
      path === "/" ? "index.html" : path.replace(/^\/+/u, ""),
    );
    if (file !== SITE && !file.startsWith(SITE + sep)) {
      response.writeHead(403).end("no");
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("nope");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  });
  await new Promise((listening) => site.listen(0, "127.0.0.1", listening));
  site.url = `http://127.0.0.1:${site.address().port}/`;
  site.kill = (value) => {
    dead = value;
  };
  return site;
}
