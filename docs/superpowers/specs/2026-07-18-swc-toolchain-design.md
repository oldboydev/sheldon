# SWC toolchain design

## Decision

Sheldon will use SWC for both production compilation and Vitest TypeScript transforms. Vitest remains the only test runner and assertion framework.

## Scope

- Replace the current `esbuild` API build script with `@swc/core`.
- Produce the existing CLI artifact at `apps/cli/dist/sheldon.js` as ESM targeting Node.js 24.
- Keep runtime dependencies (`commander`, `yaml`, and Node built-ins) external rather than bundling them.
- Configure Vitest to transform TypeScript with SWC.
- Preserve the existing `npm run build`, `npm test`, and `npm run verify` interfaces.
- Remove `esbuild` from development dependencies.

## Build flow

`scripts/build.mjs` clears the generated output directory, compiles the CLI entry point through SWC, and writes the ESM artifact to its existing path. The build must preserve `node:` imports and leave package imports resolvable from the workspace installation.

## Test flow

Vitest discovers the existing test files unchanged. Its Vite transform pipeline uses the SWC plugin for TypeScript rather than the default TypeScript/esbuild path. Test behavior and command-line output are intentionally unchanged.

## Error handling

Build failures must return a non-zero process status and retain SWC diagnostics. The output directory is generated material and is recreated on each build; no source or vault data is modified.

## Verification

Tests will first prove that the generated CLI artifact still exposes its help command and that the Vitest configuration selects SWC. The full verification gate must then pass: formatting, linting, type checking, Markdown linting, tests, build, domain checks, repository policy, and Git diff validation.

## Non-goals

- Changing the CLI interface or vault behavior.
- Adding a cloud compiler, API, or paid dependency.
- Optimizing arbitrary source packages beyond the Sheldon CLI.
