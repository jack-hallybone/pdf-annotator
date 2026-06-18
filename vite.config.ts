import type { PreviewServerHook, ViteDevServer } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: {
  env: Record<string, string | undefined>;
};

const base = normalizeBasePath(process.env.BASE_PATH);
const devServerHost = process.env.VITE_HOST ?? '127.0.0.1';
const localAllowedHosts = ['localhost', '127.0.0.1', '::1'];

const sharedSecurityHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
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
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:"
];

function contentSecurityPolicy({
  dev = false,
  meta = false
}: {
  dev?: boolean;
  meta?: boolean;
} = {}) {
  return [
    ...baseContentSecurityPolicy.filter(
      (directive) => !(meta && directive.startsWith('frame-ancestors '))
    ),
    dev
      ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'"
      : "script-src 'self' 'wasm-unsafe-eval'",
    dev
      ? "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"
      : "connect-src 'self'"
  ].join('; ');
}

const previewSecurityHeaders = {
  ...sharedSecurityHeaders,
  'Content-Security-Policy': contentSecurityPolicy()
};

const devSecurityHeaders = {
  ...previewSecurityHeaders,
  'Content-Security-Policy': contentSecurityPolicy({ dev: true })
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

function normalizeBasePath(value: string | undefined) {
  if (!value) {
    return '/';
  }

  if (value === './') {
    return value;
  }

  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.endsWith('/')
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

export default defineConfig({
  base,
  publicDir: '.generated/renderer-assets',
  build: {
    outDir: 'out/renderer'
  },
  plugins: [react(), {
    name: 'local-security-headers',
    configureServer: applyHeaders(devSecurityHeaders),
    configurePreviewServer: applyHeaders(previewSecurityHeaders)
  }, {
    apply: 'build',
    name: 'static-csp-meta',
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: contentSecurityPolicy({ meta: true })
            },
            injectTo: 'head-prepend'
          }
        ];
      }
    }
  }],
  server: {
    host: devServerHost,
    allowedHosts: localAllowedHosts,
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true
    }
  },
  preview: {
    host: devServerHost,
    allowedHosts: localAllowedHosts,
    port: 4173,
    strictPort: true
  }
});
