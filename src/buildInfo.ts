const appVersion = __APP_VERSION__.trim() || '0.0.0';
const buildSha = __BUILD_SHA__.trim();
const buildTime = __BUILD_TIME__.trim();

function formatBuildTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function getBuildInfoLabel() {
  const parts = [`v${appVersion}`];

  if (buildTime) {
    parts.push(formatBuildTime(buildTime));
  }

  if (buildSha) {
    parts.push(buildSha.slice(0, 7));
  }

  if (!buildTime && !buildSha) {
    parts.push('dev');
  }

  return parts.join(' | ');
}

export function getBuildInfoTitle() {
  if (!buildTime && !buildSha) {
    return 'Local development build';
  }

  return [
    `Version ${appVersion}`,
    buildTime ? `Built ${formatBuildTime(buildTime)}` : undefined,
    buildSha ? `Commit ${buildSha}` : undefined
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}
