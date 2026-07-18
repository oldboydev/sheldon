const implementationPatterns = [
  /^(apps|packages|scripts)\//,
  /^(vitest\.config\.ts|package(-lock)?\.json|tsconfig\.json|eslint\.config\.mjs|prettier\.config\.mjs)$/,
];

export function evaluateChangePolicy(paths) {
  const normalized = paths.map((path) => path.replaceAll('\\', '/'));
  const hasImplementationChange = normalized.some((path) =>
    implementationPatterns.some((pattern) => pattern.test(path)),
  );
  if (!hasImplementationChange) return [];

  const errors = [];
  if (!normalized.includes('README.md')) {
    errors.push('Implementation changes require README.md in the same change set.');
  }
  if (!normalized.includes('CHANGELOG.md')) {
    errors.push('Implementation changes require CHANGELOG.md in the same change set.');
  }
  return errors;
}
