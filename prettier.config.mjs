export default {
  overrides: [
    {
      files: [
        'scripts/code-review/*.{mjs,json}',
        'scripts/ci-change-filter.mjs',
        'scripts/ci-result.mjs',
        'scripts/governance-ci.test.mjs',
      ],
      options: { singleQuote: false, printWidth: 80 },
    },
  ],
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
};
