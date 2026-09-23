import { readdirSync, readFileSync } from "node:fs";
import type { PreviewServerHook, ViteDevServer } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { PRECACHE } from "./scripts/precache.mjs";

declare const process: {
  env: Record<string, string | undefined>;
};

/*
 * The display name is declared once, as package.json's `productName`, and
 * everything showing it derives from here. package.json's `name` is a separate
 * thing: the browser-storage ids key off it, so renaming the product must not
 * move it or a reader's saved data is orphaned.
 */
const productName = readProductName();
const packageName = readPackageName();

function readProductName() {
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { productName?: string };

  if (!pkg.productName) {
    throw new Error("package.json declares no productName.");
  }

  return pkg.productName;
}

function readPackageName() {
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { name?: string };

  if (!pkg.name) {
    throw new Error("package.json declares no name.");
  }

  return pkg.name;
}

const base = normalizeBasePath(process.env.BASE_PATH);
// Absolute: Open Graph consumers do not resolve relative URLs.
const siteUrl = resolveSiteUrl(process.env.VITE_SITE_URL, base);
// Loopback by default; `npm run preview:docker` overrides it on the CLI.
const devServerHost = "127.0.0.1";
const localAllowedHosts = ["localhost", "127.0.0.1", "::1"];

const sharedSecurityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), bluetooth=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), serial=(), usb=(), clipboard-read=(self), clipboard-write=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const baseContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "frame-src 'self' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "script-src-attr 'none'",
];

function contentSecurityPolicy({
  dev = false,
  meta = false,
}: {
  dev?: boolean;
  meta?: boolean;
} = {}) {
  return [
    ...baseContentSecurityPolicy.filter(
      (directive) => !(meta && directive.startsWith("frame-ancestors ")),
    ),
    dev
      ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
      : "script-src 'self' 'wasm-unsafe-eval'",
    dev
      ? "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"
      : "connect-src 'self'",
  ].join("; ");
}

const previewSecurityHeaders = {
  ...sharedSecurityHeaders,
  "Content-Security-Policy": contentSecurityPolicy(),
};

const devSecurityHeaders = {
  ...previewSecurityHeaders,
  "Content-Security-Policy": contentSecurityPolicy({ dev: true }),
};

function applyHeaders(headers: Record<string, string>) {
  return (server: ViteDevServer | Parameters<PreviewServerHook>[0]) => {
    server.middlewares.use((_request, response, next) => {
      for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
      }
      next();
    });
  };
}

function resolveSiteUrl(value: string | undefined, basePath: string) {
  const origin = value?.trim() || "http://127.0.0.1:5173";
  // new URL() rather than string concatenation: it collapses the double slash
  // when the origin already carries a path, which Pages base URLs do.
  return new URL(basePath, `${origin.replace(/\/+$/, "")}/`).href;
}

function normalizeBasePath(value: string | undefined) {
  if (!value) {
    return "/";
  }

  if (value === "./") {
    return value;
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

// Read off disk rather than passed, so the name has one source of truth: a
// disagreement between writer and reader is a 404 for every font in a document.
function pdfjsAssetDir() {
  const found = readdirSync(".generated/renderer-assets").filter((entry) =>
    /^pdfjs-[0-9a-f]{12}$/.test(entry),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one pdfjs-<digest> directory in .generated/renderer-assets, ` +
        `found ${found.length}: ${found.join(", ") || "none"}. Run ` +
        `\`node scripts/prepare-renderer-assets.mjs\` first.`,
    );
  }
  return found[0];
}

export default defineConfig({
  base,
  define: {
    __PRODUCT_NAME__: JSON.stringify(productName),
    __PACKAGE_NAME__: JSON.stringify(packageName),
    __PDFJS_ASSET_DIR__: JSON.stringify(pdfjsAssetDir()),
  },
  publicDir: ".generated/renderer-assets",
  build: {
    // The service-worker generator precaches every allowed output file, so a
    // rebuild must never retain obsolete hashed bundles from a prior build.
    emptyOutDir: true,
    outDir: "dist",
    // Just above the tabbedapp chunk, which is PDF.js plus the editor, so the
    // alarm still fires on anything new crossing it. Giving PDF.js its own
    // manual chunk was tried and reverted: Vite hoisted it into index.html as a
    // render-blocking stylesheet, putting 232 kB in front of first paint. Check
    // any future attempt against the built index.html, not the dev server.
    chunkSizeWarningLimit: 950,
  },
  plugins: [
    react(),
    {
      // Not build-only: the dev server serves the same index.html, and an
      // unsubstituted %SITE_URL% or %PRODUCT_NAME% would ship as a literal in
      // the markup.
      name: "index-html-tokens",
      transformIndexHtml: {
        order: "pre",
        handler: (html: string) =>
          html
            .replaceAll("%SITE_URL%", siteUrl)
            .replaceAll("%PRODUCT_NAME%", productName),
      },
    },
    {
      name: "local-security-headers",
      configureServer: applyHeaders(devSecurityHeaders),
      configurePreviewServer: applyHeaders(previewSecurityHeaders),
    },
    {
      apply: "build",
      name: "static-csp-meta",
      transformIndexHtml: {
        order: "pre",
        handler() {
          return [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: contentSecurityPolicy({ meta: true }),
              },
              injectTo: "head-prepend",
            },
          ];
        },
      },
    },
    // The service worker: `src/sw.js` is the source, and the precache manifest
    // is derived from the finished build by scripts/precache.mjs.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      // src/browserapp/pwa.ts registers it, guarded on PROD and on the API existing.
      // Letting the plugin inject a second registration would put that decision in two
      // places.
      injectRegister: null,
      // src/browserapp/assets/site.webmanifest is the manifest and
      // scripts/prepare-renderer-assets.mjs fills its display name from package.json.
      // Nothing here may write a second one.
      manifest: false,
      injectManifest: {
        ...PRECACHE,
        // A classic worker, not an ES module. Two reasons, and the second is why
        // this is not cosmetic: src/browserapp/pwa.ts registers it without
        // `type: "module"`, which is the only form every browser supports; and
        // the plugin's default "es" path hard-codes rolldown's deprecated
        // `inlineDynamicImports`, so every build printed a deprecation warning
        // that no edit in this repository could answer.
        rollupFormat: "iife",
      },
      // No skipWaiting and no clientsClaim: a new worker installs, precaches and waits,
      // which is the behaviour this project already had. Taking over mid-session would
      // let a page load half of one build and half of the next.
    }),
  ],
  server: {
    host: devServerHost,
    allowedHosts: localAllowedHosts,
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true,
    },
  },
  preview: {
    host: devServerHost,
    allowedHosts: localAllowedHosts,
    port: 4173,
    strictPort: true,
  },
});
