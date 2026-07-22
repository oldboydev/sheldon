# OCR Runtime Handoff

## Objective

Finish a reproducible, signed official catalog release in which `source.image` contains a real
Tesseract runtime plus `por` and `eng` models for Windows, Linux, and macOS. Do not publish a
GitHub tag/release without an explicit user request.

## Repository State

- Workspace: `C:\Users\paulo\projects\sheldon`
- Branch: `codex/official-catalog-image-ocr`
- User configured the GitHub Actions secret `SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM`.
- Public verification key was rotated in commit `179503a`.
- The catalog/release implementation is already committed and passed `npm run verify` before the
  runtime-builder work began.

## Relevant Commits

- `aaa0098` — runtime build design.
- `c03aa33` — runtime build implementation plan.
- `de7f8f2`, `e25607d`, `6cc4453`, `885ef94` — strict runtime artifact staging, symlink defense,
  immutable source pins, and corrected Tesseract source checksum.
- `7cd96e9` — approved decision to package private shared runtime libraries instead of attempting
  a fully static Tesseract build.

## Current Uncommitted Work

Do not discard these files; finish, test, and commit them as the next task:

```text
package.json
scripts/release/build-ocr-runtime.mjs
scripts/release/test/build-ocr-runtime.test.ts
scripts/release/prepare-ocr-runtime.mjs
scripts/release/test/prepare-ocr-runtime.test.ts
packages/plugins/official/source.image/src/runtime.ts
packages/plugins/official/source.image/src/plugin.ts
packages/plugins/official/source.image/test/runtime.test.ts
packages/plugins/official/source.image/test/plugin.test.ts
```

The intended behavior is:

- `prepareOcrRuntime` accepts optional regular files beneath
  `runtime/<platform>/lib/`, rejects links and empty/invalid library directories, and copies the
  tree safely into staging.
- The `source.image` plugin builds an environment for its **child Tesseract process only**:
  prepend `runtime/<platform>/lib` to `PATH` on Windows, `LD_LIBRARY_PATH` on Linux, and
  `DYLD_FALLBACK_LIBRARY_PATH` on macOS. It must preserve any existing value and never mutate
  `process.env`.
- `build-ocr-runtime.mjs` is a Node wrapper for `npm run build:ocr-runtime -- --platform
linux-x64 --output <dir>`. It invokes Docker without a shell and validates the output with
  `prepareOcrRuntime`.

Run focused release/source-image tests and `npm run typecheck` before committing this work.

## Verified Supply-Chain Inputs

`scripts/release/ocr-runtime-sources.mjs` pins Tesseract 5.5.2 source commit:

```text
revision: 6e1d56a847e697de07b38619356550e5cf4e8633
archive sha256: 51342815a262a5c1d000bab44503ddbf71ef210053375d504f619ca7a3b381bd
```

The checksum was independently obtained by downloading the official commit-addressed GitHub
archive in Docker. Do not replace it with the prior incorrect value.

## Docker Findings

Docker Desktop is active and usable:

```text
Docker 29.5.3; linux/x86_64
```

The following command worked with elevated local permission:

```powershell
docker run --rm --platform linux/amd64 alpine:3.22.2 sh -lc "apk add --no-cache curl tar cmake ninja build-base leptonica-dev"
```

Alpine `leptonica-dev` does **not** provide `liblept.a`; it provides shared libraries. This is why
the user explicitly approved the private `lib/` approach. The future Dockerfile must compile
Tesseract from pinned source, then copy its non-system `ldd` dependencies into
`/output/runtime/linux-x64/lib/`; it must not use a prebuilt `tesseract-ocr` package as the
published executable. Set the loader path only in the Tesseract child environment as described
above. Download and SHA-256-check `eng`/`por` models before putting them in `/output/data/tessdata`.

The Dockerfile does not exist yet: create `scripts/release/Dockerfile.ocr-linux`. It must run:

```text
tesseract --tessdata-dir /output/data/tessdata --list-langs
```

with its private library directory available, and its output must include `eng` and `por`.

## Remaining Plan

The approved plan is [2026-07-21-reproducible-ocr-runtime.md](../plans/2026-07-21-reproducible-ocr-runtime.md).

1. Finish and commit the private-library contract work above.
2. Create/test the Docker Linux builder and real health-check.
3. Add native GitHub Actions jobs for `win32-x64`, `linux-x64`, `darwin-x64`, and `darwin-arm64`.
4. Make the release workflow download/validate all runtime artifacts before existing catalog
   build/sign/verify; `workflow_dispatch` must not upload a release, while a `v*` tag may publish.
5. Run `npm run verify`, run the local Docker health-check, and trigger a manual GitHub dry run.
6. Ask the user before pushing a tag; this updates the production `official-catalog` release.

## Safety Rules

- Never commit or print the private signing key.
- Reject symlinks in staging and runtime artifacts.
- Keep every remote input commit-addressed and SHA-256 verified.
- Do not silently switch to package-manager Tesseract or an unpinned third-party binary.
