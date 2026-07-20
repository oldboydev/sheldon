# Task 4 implementation report

## Status

Implementation complete. Commit pending at the time this report was first written because the
sandbox denied creation of `.git/index.lock`; the commit is retried immediately after this report.

## Scope

- Added `publishPluginFileIngestion` and its public types/error contract.
- Re-exported the publisher without removing or changing `LocalFileIngestor` exports.
- Added focused publisher tests and an M2 legacy-manifest regression test.
- No CLI selection, routing, plugin-host, SDK, or official-plugin files were changed.

## Behavior implemented

- Requires exactly one host-validated `original` and one `normalized` descriptor.
- Publishes the original, `content.md`, validated `assets/**`, and `manifest.yaml` through a staging
  directory followed by atomic rename.
- Uses M2-compatible identity:
  `sha256(original_sha256 + "\n" + sha256(stable_json(options)))`.
- Returns the existing raw for equal bytes/options and validates identity before deduplication.
- Resolves equal concurrent publishers through winner-on-rename behavior; staging directories are
  always cleaned.
- Scans immutable raw manifests for the latest matching `canonical_uri` and `options_sha256`, then
  records `previous_source_id` for changed bytes.
- Does not introduce a mutable index.
- Persists plugin id/version, extractor, extraction status/format/warnings/language, relevant options,
  and hashes/byte counts/media types for original, normalized content, and assets.
- Persists manifest paths with `/` separators on every platform.
- Accepts compatible legacy M2 manifests that lack extractor/plugin-version fields.
- Raises `PluginFileIngestionError` for missing or duplicate required roles, malformed history,
  deterministic source conflicts, invalid options, and asset paths outside `assets/`.

## TDD evidence

### RED 1 — publisher absent

Command:

```text
npm test -- --run packages/ingestion/test/plugin-file-ingestor.test.ts
```

Result: exit 1. Vitest failed importing `../src/plugin-file-ingestor.js` because the publisher did
not exist. This was the expected feature-missing failure before production code was added.

### RED 2 — M2 identity mismatch found during self-review

Command:

```text
npm test -- --run packages/ingestion/test/plugin-file-ingestor.test.ts -t "deduplicates a compatible legacy M2 raw"
```

Result: exit 1. Expected legacy source id
`df5de3f88fd1d863cbc91fd0639e9e5ef006ed6e33850aedfe60d5e72f98fd29`, but the initial publisher
created `cca2fdd2ab834c224e76fad7db5f3c27c11c477bb87519b590a8a65c236a91b1`. The implementation was
then corrected to use the established M2 options-hash identity component.

## Final verification evidence

Final combined verification command:

```text
npx prettier --write packages/ingestion/src/plugin-file-ingestor.ts packages/ingestion/test/plugin-file-ingestor.test.ts
npm test -- --run packages/ingestion/test/local-file-ingestor.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts
npm run typecheck
npx prettier --check packages/ingestion/src/plugin-file-ingestor.ts packages/ingestion/src/index.ts packages/ingestion/test/plugin-file-ingestor.test.ts packages/ingestion/test/local-file-ingestor.test.ts
git diff --check -- packages/ingestion
```

Result: exit 0.

- Vitest: 2 test files passed, 14 tests passed, 0 failed.
- TypeScript: `tsc --noEmit` passed.
- Prettier: all matched files use Prettier style.
- Diff check: no whitespace errors.
- Focused ESLint was also run on the four assigned ingestion files and exited 0.

Coverage explicitly includes atomic publication, hashes and plugin metadata, changed-byte version
linkage, exact deduplication, four-way concurrent publication, required-role absence/duplication,
asset path escape, malformed history, source identity conflict, portable asset paths, and legacy M2
manifest compatibility.

## Self-review

- Confirmed publication trusts the host-validated lease and does not add CLI selection/routing.
- Confirmed only `asset` roles are copied in addition to the required original/normalized roles;
  metadata/inventory artifacts are not published accidentally.
- Confirmed the manifest is written only after artifact copies complete and before staging rename.
- Confirmed staging cleanup executes on success, failure, and rename-race loss.
- Confirmed historical parsing requires deterministic identity fields but does not require newer
  extractor/plugin-version fields.
- Confirmed no mutable version index or edits outside the assigned Task 4 paths.

## Concerns

None in the implementation or test results. The only operational issue encountered was sandbox
permission for `.git/index.lock`; it does not affect the workspace changes or verification evidence.

## Review-finding fixes (2026-07-20)

### Behavior corrected

- New plugin raws now use the binding identity
  `SHA-256(original bytes + "\n" + stable JSON(relevant options))`.
- The M2 hash-of-hashes identity remains a compatibility-only lookup. A matching legacy raw is
  returned with `manifestFormat: legacy-m2` and its truthful identity-only manifest shape; current
  manifests return `manifestFormat: plugin-v1`.
- Historical candidates are ignored unless their identity fields are lowercase SHA-256 values,
  their `source_id` matches the containing directory, and `captured_at` has valid ISO timestamp
  syntax. Malformed YAML and incomplete historical directories are ignored.
- A file, empty directory, incomplete directory, or malformed manifest at either deterministic
  lookup target is reported as `PluginFileIngestionError` with
  `PLUGIN_FILE_SOURCE_CONFLICT`.
- Original bytes are read once, hashed, written, and recorded in the manifest so the published
  bytes and canonical identity cannot diverge during publication.

### TDD evidence

RED command:

```text
npm test -- --run packages/ingestion/test/plugin-file-ingestor.test.ts
```

RED result: exit 1; 5 expected failures and 5 passes. The failures independently demonstrated the
old hash-of-hashes ID, missing legacy result discriminant, rejection of malformed history, an
untyped/undetected occupied-file target, and misclassification of an occupied directory as
`PLUGIN_FILE_HISTORY_INVALID`.

Public type RED command:

```text
npm run typecheck
```

RED result: exit 1 with TS2724 because `LegacyM2PluginFileManifest` was not yet exported from the
ingestion entrypoint. The type was then re-exported and the check passed.

### Verification evidence

- Focused tests:
  `npm test -- --run packages/ingestion/test/local-file-ingestor.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts`
  — exit 0, 2 files and 17 tests passed.
- Full tests: `npm test` — exit 0, 37 files and 252 tests passed.
- TypeScript: `npm run typecheck` — exit 0.
- Focused ESLint on the four Task 4 ingestion files — exit 0.
- Prettier applied to the three changed source/test files; scoped diff check exited 0.

### Concerns after fixes

None.

## Follow-up review fixes (2026-07-20)

This section supersedes the earlier statement that all malformed historical candidates are ignored.
The Task 4 brief requires a malformed relevant history manifest to raise a typed error.

### Behavior corrected

- History scanning now checks relevance using `canonical_uri` and `options_sha256` before accepting
  a candidate. A relevant candidate with malformed hashes, directory identity, or timestamp raises
  `PLUGIN_FILE_HISTORY_INVALID`; candidates for other URI/options pairs do not enter version
  selection.
- Filesystem read failures for `manifest.yaml` are normalized to
  `PLUGIN_FILE_SOURCE_CONFLICT` at a deterministic source target and
  `PLUGIN_FILE_HISTORY_INVALID` during history scanning, including when `manifest.yaml` is itself a
  directory.
- Historical timestamps with offsets are ordered by their parsed instant, with `source_id` as the
  deterministic tie-breaker, rather than by timestamp text.
- ISO timestamp validation now rejects calendar-invalid values such as February 30 instead of
  accepting JavaScript date normalization.

### RED/GREEN evidence

- Relevant malformed history RED: the targeted test resolved and published instead of rejecting.
  GREEN: the same test passed with `PLUGIN_FILE_HISTORY_INVALID`.
- Unreadable manifest RED: two targeted cases exposed raw `EISDIR` for deterministic source and
  history paths. GREEN: both passed with their respective typed plugin errors.
- Offset ordering RED: `2026-07-20T13:00:00+02:00` incorrectly beat the later
  `2026-07-20T12:00:00Z`. GREEN: numeric instant ordering selected the latter.
- Calendar validation RED: `2026-02-30T12:00:00Z` was accepted and linked. GREEN: the relevant
  history candidate was rejected with `PLUGIN_FILE_HISTORY_INVALID`.

### Final focused verification

```text
npm test -- --run packages/ingestion/test/local-file-ingestor.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts
npm run typecheck
npx eslint packages/ingestion/src/plugin-file-ingestor.ts packages/ingestion/test/plugin-file-ingestor.test.ts
npx prettier --check packages/ingestion/src/plugin-file-ingestor.ts packages/ingestion/test/plugin-file-ingestor.test.ts
```

Result: exit 0. Vitest passed 2 files and 21 tests; TypeScript, focused ESLint, and Prettier all
passed.

### Controller-review concern

The reviewer identified a narrow POSIX race where an empty target directory created after the
preflight check might be replaced by `rename`. No new cross-platform no-replace primitive was added
without an existing precise mechanism, per controller direction. This remains an explicit concern
for controller review.
