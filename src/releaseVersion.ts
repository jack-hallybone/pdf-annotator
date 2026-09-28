/* The release version, as deploy.yml's sed step stamped it into index.html's #version span before the build; an unstamped build ships the literal below. */
export const RELEASE_VERSION =
  document.querySelector("#version")?.textContent?.trim() || "v. dev";
