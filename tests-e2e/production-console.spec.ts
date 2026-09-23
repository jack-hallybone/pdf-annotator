import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Measured on the built artifact, because the dev server rewrites module URLs,
// injects its own client and sets headers GitHub Pages never sends.

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const rendererOut = fileURLToPath(new URL("../dist/", import.meta.url));

// The filenames are named rather than globbed, so dropping a warm-up fails here;
// the directory is read off the build, whose digest changes with pdfjs-dist.
const pdfjsDir = readdirSync(rendererOut).filter((entry) =>
  /^pdfjs-[0-9a-f]{12}$/.test(entry),
);
if (pdfjsDir.length !== 1) {
  throw new Error(
    `expected exactly one pdfjs-<digest> directory in dist, found ` +
      `${pdfjsDir.length}: ${pdfjsDir.join(", ") || "none"}`,
  );
}
const WARMED_WASM = ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"].map(
  (file) => `/${pdfjsDir[0]}/wasm/${file}`,
);

const CONTENT_TYPES: Record<string, string> = {
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

let server: Server;
let origin: string;
const serverHits = new Map<string, number>();

test.beforeAll(async () => {
  test.setTimeout(300_000);

  // Always, never "only if dist is missing": an assertion about the
  // shipped file is worth nothing if an older source tree left that file behind.
  // Root-served, always: `serve()` below maps every path 1:1 onto dist/, with
  // no notion of a base path, so a leaked BASE_PATH/VITE_SITE_URL (CI sets
  // both on the same step that runs this, for the outer build that ships)
  // bakes a subpath into every asset URL this server can't answer to.
  const env = { ...process.env };
  delete env.BASE_PATH;
  delete env.VITE_SITE_URL;
  execFileSync("npm", ["run", "build"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });

  server = createServer((request, response) => {
    void serve(request.url ?? "/").then(({ status, type, body }) => {
      response.writeHead(status, { "Content-Type": type });
      response.end(body);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("static server did not bind a port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function serve(url: string) {
  const requested = new URL(url, "http://localhost");
  const path = decodeURIComponent(requested.pathname);
  serverHits.set(
    `${path}${requested.search}`,
    (serverHits.get(`${path}${requested.search}`) ?? 0) + 1,
  );

  const file = join(
    rendererOut,
    normalize(path.endsWith("/") ? `${path}index.html` : path),
  );
  if (!file.startsWith(rendererOut.replace(/\/$/, "") + sep)) {
    return { status: 403, type: "text/plain", body: "forbidden" };
  }

  try {
    return {
      status: 200,
      type: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      body: await readFile(file),
    };
  } catch {
    return { status: 404, type: "text/plain", body: "not found" };
  }
}

function stampedHits(path: string) {
  let total = 0;
  for (const [url, count] of serverHits) {
    if (url.startsWith(`${path}?`)) {
      total += count;
    }
  }
  return total;
}

test("the built app loads with a silent console and fetches each asset once", async ({
  page,
}) => {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const pageRequests = new Map<string, number>();
  serverHits.clear();

  page.on("console", (message) =>
    consoleMessages.push(`[${message.type()}] ${message.text()}`),
  );
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    pageRequests.set(path, (pageRequests.get(path) ?? 0) + 1);
  });

  await page.goto(`${origin}/`, { waitUntil: "load" });
  await expect(page.locator(".browserapp-home-card")).toBeVisible();

  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        void navigator.serviceWorker.ready.then(() => resolve());
        setTimeout(
          () => reject(new Error("no service worker activated")),
          20_000,
        );
      }),
  );

  // The warm-up runs on an idle callback with a 600 ms timeout and Chromium
  // reports an unused preload a few seconds after load.
  await page.waitForTimeout(5_000);

  // A page that never loaded would satisfy every assertion below by doing nothing.
  expect(
    [...serverHits.values()].reduce((total, count) => total + count, 0),
  ).toBeGreaterThan(5);

  expect(pageErrors).toEqual([]);
  expect(consoleMessages).toEqual([]);

  // The warm-up has been dropped, so only the worker's install should ask for
  // these. The stamped count is asserted as 0 rather than deleted: these files are
  // content-hashed by directory, so nothing may file them under a query key again.
  for (const asset of WARMED_WASM) {
    expect(
      pageRequests.get(asset),
      `${asset} should not be requested by the page — the worker precaches it, ` +
        "and warming it here is the 443 kB double download that was removed",
    ).toBeUndefined();
    expect(
      serverHits.get(asset),
      `${asset} should cross the network exactly once, for the worker's precache`,
    ).toBe(1);
    expect(
      stampedHits(asset),
      `${asset} should have no ?v=<stamp> copy: its identity is in its directory`,
    ).toBe(0);
  }
});
