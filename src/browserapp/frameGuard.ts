// Production's only clickjacking guard: Pages serves no headers, so neither X-Frame-Options nor a header CSP reaches it, and the <meta> CSP it does ship cannot express frame-ancestors.
export function isBrowserAppFramed() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
