import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// End-to-end smoke net. Kept separate from the unit/DOM suites (`npm test`)
// because it needs a real browser and a running dev server. Run with
// `npm run test:e2e`.
//
// Browser resolution: prefer an explicit PLAYWRIGHT_CHROMIUM_PATH, then this
// environment's pre-installed Chromium (so we don't re-download it here). If
// neither exists - e.g. in CI after `npx playwright install chromium` - fall
// back to Playwright's own bundled browser by leaving executablePath unset.
const explicitChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const bundledChromium = "/opt/pw-browsers/chromium";
const chromiumPath =
  explicitChromium ??
  (existsSync(bundledChromium) ? bundledChromium : undefined);

export default defineConfig({
  testDir: "./tests-e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // CI sets these for the outer build that ships; baseURL above assumes
    // root, so a leaked base path serves this dev server under a subpath
    // instead, and nothing above ever finds it. Spread first: this option
    // replaces process.env rather than merging into it, so a bare override
    // would also drop PATH and everything else npm run dev needs to launch.
    env: { ...process.env, BASE_PATH: "", VITE_SITE_URL: "" },
  },
});
