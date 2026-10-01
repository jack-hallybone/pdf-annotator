// Built here rather than found here: a directory found on disk can be older than the source.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
export const SITE = join(ROOT, "dist");
// deploy.yml builds for the Pages sub-path in BASE_PATH, as vite.config.ts reads it, so this serves and opens the site under it too. Stripped of any trailing slash: vite.config.ts's own normalizeBasePath() tolerates one or none on the way in, and the `${BASE}/`s below need exactly one slash, not two, to match the single-slash paths a browser actually requests.
const BASE = (process.env.BASE_PATH ?? "").replace(/\/+$/u, "");

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

// The returned server's `kill()` refuses every request at the socket, which is what a dead network looks like to a service worker.
export async function serveBuiltSite(expect = "index.html") {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  if (!existsSync(join(SITE, expect))) {
    throw new Error(`the build produced no dist/${expect}`);
  }

  let dead = false;
  // A byte-different sw.js is a new worker, so a trailing comment stands in for a second deploy.
  let redeployed = false;
  const SW_FILE = join(SITE, "sw.js");
  const site = http.createServer((request, response) => {
    if (dead) {
      request.socket.destroy();
      return;
    }
    const raw = decodeURIComponent((request.url ?? "/").split(/[?#]/u, 1)[0]);
    const path = raw.startsWith(`${BASE}/`) ? raw.slice(BASE.length) : raw;
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
    const body = readFileSync(file);
    response.end(
      redeployed && file === SW_FILE
        ? Buffer.concat([body, Buffer.from("\n// deploy 2\n")])
        : body,
    );
  });
  await new Promise((listening) => site.listen(0, "127.0.0.1", listening));
  site.url = `http://127.0.0.1:${site.address().port}${BASE}/`;
  site.kill = (value) => {
    dead = value;
  };
  site.redeploy = () => {
    redeployed = true;
  };
  // Back to the real build, so a suite can install it fresh before simulating its own next deploy.
  site.reset = () => {
    redeployed = false;
  };
  return site;
}
