# Task 4 report — source.file boundary

Status: DONE

## Changes

- Moved `packages/plugins/official/sheldon.file` to `packages/plugins/official/source.file`.
- Renamed the workspace alias and plugin API to `@sheldon/plugin-source-file`, `createOfficialSourceFilePlugin`, and `runOfficialSourceFilePlugin`.
- Changed the manifest identity to `source.file`.
- Removed image recognition, OCR options/metadata, Tesseract adapters/executable probing, and the OCR healthcheck/dependency.
- Preserved offline document extraction, safeguards, original artifacts, normalized `content.md`, and Node plus embedded-extractor health checks.
- Updated the CLI acceptance harness to install `source.file` through an official-catalog client fixture before ingest.

## RED/GREEN evidence

The literal RED command from the brief, run before the target directory existed, exited 0 because Vitest uses `--passWithNoTests`; it found no `source.file` tests.

The pre-move test command then produced the feature-level RED evidence:

`npm test -- --run packages/plugins/official/sheldon.file/test apps/cli/test/file-ingestion-acceptance.test.ts`

It failed in five expected places: legacy `sheldon.file` identity, PNG claimed at confidence 100, image extraction format, Tesseract dependency, and OCR metadata. Production behavior was unchanged when it ran.

GREEN command:

`npm test -- --run packages/plugins/official/source.file/test apps/cli/test/file-ingestion-acceptance.test.ts`

Result: 4 files passed, 39 tests passed.

## Verification

`npm run build` passed.

`npm test -- --run packages/plugins/official/source.file/test apps/cli/test/file-ingestion-acceptance.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts` passed: 5 files / 61 tests.

`npm run verify:plugin-contract` passed for `fixture.node-sdk`, `fixture.powershell`, and `source.file`.

`npm test` passed: 42 files / 323 tests.

`npm run typecheck` and `git diff --check` passed.

A final Task-4 scope scan for `sheldon.file`, `@sheldon/plugin-file`, Tesseract adapter/API names, and `FILE_OCR_UNAVAILABLE` found no matches in the moved package, its build output, configuration, scripts, lockfile, or file-ingestion acceptance test.

## Auto-review

- Image signatures/extensions/extractor and Tesseract runtime handling are absent from `source.file`.
- Non-empty ingest options reject with `FILE_INPUT_INVALID`.
- Manifest permissions remain offline and dependencies contain only Node.
- Optional installation is exercised before CLI file ingestion.
- Preserved the two pre-existing plan files in `docs/superpowers/plans/`; they are not staged.

## Concern

The exact brief RED command can mask a missing directory due to `--passWithNoTests`; the alternate pre-move command above establishes the required behavior-level failing evidence.
