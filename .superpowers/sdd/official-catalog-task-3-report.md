# Task 3 — Official catalog CLI report

## Outcome

Replaced bundled official-plugin CLI behavior with explicit local registry and signed remote catalog commands. `plugin list` is local-only; `--remote` explicitly loads the catalog and detached signature. Catalog installs accept canonical IDs only and use the host installer without launching a plugin process.

## RED

Added `apps/cli/test/official-catalog-cli.test.ts` before implementation and ran:

```text
npm test -- --run apps/cli/test/plugins.test.ts apps/cli/test/official-catalog-cli.test.ts
```

It failed as expected because `apps/cli/src/official-catalog.ts` and the injected catalog CLI surface did not exist.

## GREEN

Implemented:

- `apps/cli/src/official-catalog.ts`: exact release URLs, embedded public-key loading, Ed25519 detached-signature verification, catalog download handling, canonical ID validation, and catalog-backed host installation.
- `apps/cli/src/main.ts` and `apps/cli/src/runtime.ts`: injected `OfficialCatalogClient` and `OfficialPlatform`, plus `plugin list --remote`, `plugin info <id> [--remote]`, and ID-only install wiring.
- `apps/cli/src/commands/plugins.ts`: local list/info behavior, stable remote catalog rendering, platform and installation state, remote-only info lookup, and removable local registry entries.
- `apps/cli/src/plugin-services.ts`: local discovery receives no bundled official roots.
- `scripts/build.mjs`: removes stale CLI plugin trees and copies only `release/official-catalog-public.pem` to CLI dist.
- `release/official-catalog-public.pem`: compiled verification key.

Migrated legacy CLI acceptance fixtures from injected bundled roots to locally seeded registry entries, including self-contained fixture plugins for file ingestion and M2.

## Test evidence

Focused catalog/host tests:

```text
npm test -- --run apps/cli/test/plugins.test.ts apps/cli/test/official-catalog-cli.test.ts packages/plugin-host/test/official-catalog.test.ts
PASS — 3 files, 38 tests
```

Focused local-registry acceptance tests:

```text
npm test -- --run apps/cli/test/file-ingestion-acceptance.test.ts apps/cli/test/m2-acceptance.test.ts
PASS — 2 files, 9 tests
```

Final verification:

```text
npm run typecheck
PASS

npm test
PASS — 42 files, 328 tests

npx prettier --check <changed source/test files>
PASS

npm run lint
PASS

npm run build
PASS

git diff --check
PASS
```

The build verification confirmed `apps/cli/dist/plugins` is absent and `apps/cli/dist/official-catalog-public.pem` exists.

## Self-review

- Local `plugin list` does not call the catalog client; the regression test asserts zero loads.
- Remote listing is explicit, renders in stable ID order, includes version/description/platform and installed state, and does not persist catalog data.
- Local `plugin info` rejects uninstalled entries; `--remote` resolves only from the signed catalog.
- `plugin install` rejects URLs and other noncanonical IDs with `OFFICIAL_PLUGIN_ID_INVALID`; real client installs only an ID found in the verified catalog.
- Catalog list/info/install never construct or invoke `PluginProcessRunner`; installation delegates to the host artifact installer only.
- No default bundled official-plugin root remains, and removal operates on local registry records.

## Commit

Pending: `feat(cli): install official plugins from signed catalog`

## Concerns

None unresolved. The pinned public key is intentionally non-secret and copied as the only catalog-related runtime asset; signed release publishing remains outside this task.
