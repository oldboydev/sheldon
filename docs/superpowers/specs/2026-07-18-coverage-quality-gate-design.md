# Coverage quality-gate design

## Decision

Sheldon will measure TypeScript source coverage with Vitest's local V8 provider and enforce an initial balanced quality gate: 80% for statements, functions, and lines; 70% for branches.

## Scope

- Add the free, local `@vitest/coverage-v8` development dependency.
- Add an `npm run coverage` command that runs Vitest with coverage enabled.
- Include coverage in `npm run verify` so threshold regressions fail the repository gate.
- Measure all source under `apps/**/src` and `packages/**/src`, including files not reached by tests.
- Exclude tests, declaration files, configuration files, generated `dist/`, dependencies, and generated coverage reports.
- Produce terminal, JSON, and HTML reports locally under `coverage/`.

## Thresholds

| Metric     | Minimum |
| ---------- | ------: |
| Statements |     80% |
| Functions  |     80% |
| Lines      |     80% |
| Branches   |     70% |

The lower branch threshold acknowledges that early CLI error paths and filesystem guards have more decision points than their line count suggests. It remains high enough to prevent untested conditional behavior from becoming routine.

## Runtime behavior

`npm test` remains the fast feedback command and does not collect coverage. `npm run coverage` creates the reports and evaluates thresholds. `npm run verify` calls `npm run coverage` after the normal test suite, before build and repository-policy checks.

## Verification

Tests will first prove the configuration declares the V8 provider, source scope, report formats, and all four thresholds. The implementation is complete only if the full verification gate passes with all thresholds enforced.

## Non-goals

- Uploading reports to a SaaS, badge provider, or cloud API.
- Enabling automatic threshold rewriting.
- Replacing Vitest or SWC.
