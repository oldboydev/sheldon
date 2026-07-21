# Task 2 — Verified official artifact installation

## Scope

Implemented the trusted official-plugin artifact boundary: bounded streamed download, SHA-256 verification, private ZIP extraction, manifest/catalog matching, cleanup, atomic registry installation, and installed-plugin tamper detection.

## Files changed

- `packages/plugin-host/src/official-download.ts` (new)
- `packages/plugin-host/src/official-installer.ts` (new)
- `packages/plugin-host/src/registry.ts`
- `packages/plugin-host/src/index.ts`
- `packages/plugin-host/test/official-download.test.ts` (new)
- `packages/plugin-host/test/official-installer.test.ts` (new)

## TDD evidence

### RED

Created focused hostile-download and installer tests before the production APIs existed. Ran:

```text
npm test -- --run packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts
```

Result: 10 failures, each because `downloadOfficialArtifact` or `installOfficialPlugin` was not yet a function. This established the intended public behavior before implementation.

### GREEN

Implemented the minimal trusted download/extraction/install path, then reran the focused tests. Result: 14 passing tests.

Coverage includes:

- exact chunked artifact bytes and exact catalog URL use;
- bad status, missing body, interrupted stream, size mismatch, and digest mismatch;
- archive traversal, duplicate central-directory entries, symlink entries, multiple roots, and manifest mismatch;
- temporary-extraction cleanup on archive failures;
- non-overwrite collision behavior for an unhealthy local `source.image` directory;
- registry-backed installed-manifest tamper detection without mutating registry state.

### Refactor

Formatted all touched TypeScript files with Prettier. No behavior changes were made during formatting.

## Verification

Focused suite:

```text
npm test -- --run packages/plugin-host/test/registry.test.ts packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts
```

Result: 3 files passed, 44 tests passed.

Type check:

```text
npm run typecheck
```

Result: passed.

Formatting and whitespace:

```text
npx prettier --check packages/plugin-host/src/official-download.ts packages/plugin-host/src/official-installer.ts packages/plugin-host/src/registry.ts packages/plugin-host/src/index.ts packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts
git diff --check
```

Result: passed.

Full suite:

```text
npm test
```

First run had one unrelated timing failure in `packages/plugin-sdk/test/contract.test.ts` because its temporary fixture PID file was absent. The isolated contract test passed on retry, then a second full-suite run passed: 41 files passed, 321 tests passed.

## Self-review

- Downloads accept only HTTP 200 and a body, buffer only the exact catalog byte count, fail on any excess/short stream, and compare SHA-256 against the catalog value.
- The default ZIP extractor parses the central directory before extraction; it rejects empty/dot/traversal/backslash/drive-prefixed/duplicate paths, non-regular Unix entry types (including symlinks), and bounded decompression violations.
- Extraction occurs in a `mkdtemp` child beneath the supplied temporary root and is removed on every outcome.
- The archive must have exactly one top-level root, and its loaded installed manifest must exactly match the catalog ID/version before registry installation.
- `PluginRegistry.getInstalled` runs under the existing transaction, resolves only the exact recorded child, and raises `PLUGIN_INSTALLATION_TAMPERED` for unreadable or mismatched installed manifests without changing records.
- Existing registry collision behavior is preserved, so a pre-existing local plugin directory is never overwritten.

## Commit

`feat(plugin-host): install verified official artifacts atomically`

## Concerns

No outstanding implementation concerns. The only observed transient issue was the unrelated plugin-SDK temporary-file timing failure noted above; it passed in isolation and on the final complete-suite rerun.

## Critical-review fixes

Three critical review findings were addressed together.

### RED / GREEN evidence

New regression tests were written first and the focused test command failed for the expected missing trust-boundary behaviors:

- an arbitrary matching-hash artifact URL was fetched instead of rejected;
- an installed plugin root replaced with an outside symlink was accepted.

The forged central-directory size test was also added. It initially exposed that JSZip could follow forged central metadata. During the first green implementation attempt, its `nodeStream()` object was incorrectly treated as an async iterable; the focused tests failed with `stream is not async iterable`. The extraction writer was then changed to use the Node stream's pause/resume events for bounded sequential writes.

### Changes

- `downloadOfficialArtifact` now revalidates the exact canonical GitHub Sheldon-release URL shape before calling the injected fetcher and returns `OFFICIAL_ARTIFACT_URL_INVALID` without issuing a network request for arbitrary URLs.
- ZIP parsing cross-checks each central-directory entry's local-header flags and compressed/uncompressed sizes before extracting. Extraction no longer uses `file.async('nodebuffer')` or JSZip CRC preflight, either of which can buffer decompressed contents. It instead streams each file with pause/resume backpressure, enforcing actual per-entry and aggregate byte limits before each write, and rejects actual/declaration size mismatches.
- `PluginRegistry.getInstalled` now verifies that the lexical registry child is a real directory and that its canonical path equals the canonical `plugins/<id>` child both before and after manifest loading. A symlink/junction replacement is reported as `PLUGIN_INSTALLATION_TAMPERED` without changing registry records.

### Review-fix verification

```text
npm test -- --run packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts
```

Result: 2 files passed, 17 tests passed.

```text
npm test -- --run packages/plugin-host/test/registry.test.ts packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts
npm run typecheck
```

Result: 3 files passed, 47 tests passed; typecheck passed.

```text
npm test
```

Result: 41 files passed, 324 tests passed.

Prettier and `git diff --check` also passed after the fixes.

## Root-parent replacement re-review fix

### RED / GREEN evidence

Added a regression that installs `fixture.node`, replaces `<appRoot>/plugins` after `PluginRegistry.open()` with a symlink/junction to an external directory, retains the signed manifest bytes, and alters the executable file. The initial test run failed because `getInstalled` returned the plugin successfully.

`getInstalled` now calls the existing plugin-root safety/canonical-identity guard inside its transaction before loading the recorded child. A swapped `plugins` parent is therefore mapped to `PLUGIN_INSTALLATION_TAMPERED` with no registry mutation.

Verification:

```text
npm test -- --run packages/plugin-host/test/registry.test.ts packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts
npm run typecheck
npm test
```

Results: focused suite 48 tests passed; typecheck passed; full suite 41 files and 325 tests passed.
