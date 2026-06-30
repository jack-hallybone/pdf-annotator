export function isBrowserAppFramed() {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}
