const buildSha = __BUILD_SHA__.trim();
const buildTime = __BUILD_TIME__.trim();

function formatBuildTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// There's no hand-maintained version number here on purpose - it would need
// a human to remember to bump it on every release, and a stale one is worse
// than none. buildTime + buildSha (set by the deploy workflow) already
// identify a real deploy uniquely and automatically, so that pair *is* the
// version, prefixed with "v" the same way a hand-written one would be. A
// build with neither is a local/dev build.
export function getBuildInfoLabel() {
  if (!buildTime && !buildSha) {
    return 'dev';
  }

  const parts = [
    buildTime ? formatBuildTime(buildTime) : undefined,
    buildSha ? buildSha.slice(0, 7) : undefined
  ].filter((part): part is string => Boolean(part));

  return `v ${parts.join(' | ')}`;
}
