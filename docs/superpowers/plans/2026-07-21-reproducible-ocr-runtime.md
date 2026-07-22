# Reproducible OCR Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, validate, and inject real Tesseract runtimes and base OCR models into the official `source.image` release without committing binaries or private keys.

**Architecture:** A source-pinned runtime builder emits a platform-layout artifact. A release workflow builds one artifact per native runner, validates each one, downloads them into the existing release stage, then uses the current deterministic catalog builder, signer, verifier, and release upload unchanged. Docker exposes the Linux builder for local reproducibility.

**Tech Stack:** Node.js 24, GitHub Actions, Docker, CMake/Ninja, Tesseract 5.5.2, official tessdata_fast models, Vitest.

## Global Constraints

- Tesseract source, model revisions, and every downloaded file must have fixed SHA-256 values checked before use.
- Runtime layout is `runtime/<platform>/tesseract[.exe]`, optional regular files under
  `runtime/<platform>/lib/`, `data/tessdata/{por,eng}.traineddata`, and notices.
- Each native runtime must pass `--tessdata-dir <dir> --list-langs` before use by release.
- The private Ed25519 key remains only in `SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM`.
- A tag push is the only production publication path; `workflow_dispatch` validates without upload.

---

### Task 1: Runtime source manifest and stage validation

**Files:**

- Create: `scripts/release/ocr-runtime-sources.mjs`
- Create: `scripts/release/prepare-ocr-runtime.mjs`
- Create: `scripts/release/test/prepare-ocr-runtime.test.ts`
- Modify: `scripts/release/stage-official-artifacts.mjs`

**Interfaces:**

- Produces `prepareOcrRuntime({ platform, input, output, download })` and a staged `source.image` tree.
- Consumes a runtime artifact directory and writes only canonical runtime/model paths.

- [ ] Write tests that reject a missing platform executable, a non-regular model, an unpinned download, and an artifact with extra top-level entries.
- [ ] Run `npm test -- --run scripts/release/test/prepare-ocr-runtime.test.ts` and observe failure because the module is absent.
- [ ] Define immutable source records with URL, revision, SHA-256, license source, and the two model checksums; implement checksum validation and strict artifact-layout copy.
- [ ] Extend staging to merge validated runtime artifacts after copying the plugin source, without following symlinks.
- [ ] Re-run the focused test and `npm run typecheck`; commit `feat(release): validate OCR runtime staging`.

### Task 2: Reproducible Linux runtime builder and Docker smoke test

**Files:**

- Create: `scripts/release/Dockerfile.ocr-linux`
- Create: `scripts/release/build-ocr-runtime.mjs`
- Create: `scripts/release/test/build-ocr-runtime.test.ts`
- Modify: `package.json`
- Modify: `scripts/release/prepare-ocr-runtime.mjs`
- Modify: `scripts/release/test/prepare-ocr-runtime.test.ts`
- Modify: `packages/plugins/official/source.image/src/runtime.ts`
- Modify: `packages/plugins/official/source.image/src/plugin.ts`
- Modify: `packages/plugins/official/source.image/test/runtime.test.ts`

**Interfaces:**

- Produces `npm run build:ocr-runtime -- --platform linux-x64 --output <dir>`.
- Docker builder produces `runtime/linux-x64/tesseract`, required private runtime libraries under
  `runtime/linux-x64/lib/`, both base models, and notices.

- [ ] Write a test for command arguments and strict output-layout validation; run it red.
- [ ] Write tests that accept regular private runtime libraries, reject links or directories in
      `lib/`, and prove the plugin's child-only environment points at its packaged library directory.
- [ ] Implement a Docker image that downloads pinned source inputs, builds Tesseract, copies its
      required non-system shared libraries into `lib/`, copies model/notices, and runs
      `--tessdata-dir /output/data/tessdata --list-langs` with the private library directory.
- [ ] Implement the Node wrapper that invokes Docker only for `linux-x64`, rejects unrecognized platforms, and validates the output before returning.
- [ ] Extend runtime preparation to copy the validated `lib/` tree and make image OCR invoke only
      its child process with the matching platform loader environment.
- [ ] Run the focused tests, execute the Docker build, and verify it lists `eng` and `por`; commit `feat(release): build Linux OCR runtime in Docker`.

### Task 3: Native GitHub Actions runtime matrix

**Files:**

- Create: `.github/workflows/build-ocr-runtime.yml`
- Create: `scripts/release/build-native-ocr-runtime.ps1`
- Create: `scripts/release/build-native-ocr-runtime.sh`
- Modify: `scripts/release/test/build-ocr-runtime.test.ts`

**Interfaces:**

- Workflow artifact name is `ocr-runtime-<platform>` and contains the canonical Task 1 layout.
- The scripts accept `--platform <platform> --output <directory>` and fail on a health-check, dependency, or notice error.

- [ ] Add failing tests for the supported platform list and artifact names.
- [ ] Implement Windows x64 native build plus DLL/notices validation, and macOS x64/ARM64 native builds plus `otool -L` rejection of Homebrew paths.
- [ ] Add a `workflow_dispatch` matrix for all four platforms and upload only validated artifacts.
- [ ] Re-run focused tests and YAML/TypeScript validation; commit `ci(release): build native OCR runtime artifacts`.

### Task 4: Release integration and no-upload dry run

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `scripts/release/test/*.test.ts`

**Interfaces:**

- Release job receives `ocr-runtime-*` artifacts, validates their layout, stages them, and releases only on a tag push.

- [ ] Add a failing workflow fixture/test asserting `workflow_dispatch` has no `action-gh-release` step and tag pushes retain it.
- [ ] Make the release workflow dispatch the runtime matrix, download all artifacts into the staging input, and execute existing build/sign/verify steps.
- [ ] Document the source-pin, local Docker command, required secret, and tag-versus-dry-run behavior.
- [ ] Run `npm run verify`; commit `ci(release): publish catalog from verified OCR runtimes`.

### Task 5: Final verification

**Files:**

- Modify only if validation reveals a defect.

- [ ] Run `npm run verify`.
- [ ] Run the local Docker Linux runtime health check.
- [ ] Trigger a manual GitHub workflow dry run; inspect all four artifacts and confirm no release was uploaded.
- [ ] After explicit user authorization, push a `v*` tag to publish the `official-catalog` release.
