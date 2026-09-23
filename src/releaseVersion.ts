/*
 * The release version, as scripts/stamp_version.mjs wrote it into index.html,
 * an unstamped build keeping the literal the element ships with.
 */
export const RELEASE_VERSION =
  document.querySelector("release-version")?.textContent?.trim() || "preview";
