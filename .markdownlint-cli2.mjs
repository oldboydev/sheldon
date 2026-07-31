export default {
  // Portable-format fixtures are compiler-shaped artifacts, not authored prose.
  ignores: ['test-fixtures/okf/**', '**/node_modules/**'],
  config: {
    MD013: false,
    MD024: false,
    MD033: false,
  },
};
