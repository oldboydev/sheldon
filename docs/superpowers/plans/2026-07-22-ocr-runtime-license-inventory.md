# OCR Runtime License Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native OCR artifacts include verified license texts for every bundled private library.

**Architecture:** A shared JavaScript manifest validates immutable provider records. Native builders resolve the package provider/version of each copied library and use that manifest to fetch and hash-verify license text. An unmapped provider/version remains a hard failure.

**Tech Stack:** Node.js ESM, Vitest, PowerShell, Bash, MSYS2 pacman, Homebrew.

## Global Constraints

- Every record contains provider, exact version, HTTPS source URL, source SHA-256, non-empty license path, license SHA-256, and SPDX identifier.
- Only copied non-system runtime libraries require records.
- Unknown providers or versions fail with `OCR_RUNTIME_NOTICES_INVALID`; do not read package-manager documentation directories or infer text from SPDX labels.
- Notices include provider/version, copied libraries, source URL/SHA, license path/SHA, SPDX identifier, and verified raw license text.
- No release is published until all four native artifacts pass their health checks.

---

### Task 1: Shared inventory schema and validation

**Files:**

- Create: `scripts/release/ocr-runtime-dependency-inventory.mjs`
- Create: `scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

**Interfaces:**

- Produces `OCR_RUNTIME_DEPENDENCY_INVENTORY`.
- Produces `assertPinnedOcrRuntimeDependencyInventory(inventory)`.
- Produces `findOcrRuntimeDependency(provider, name, version, inventory)`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(() =>
  assertPinnedOcrRuntimeDependencyInventory([
    { provider: 'homebrew', name: 'leptonica', version: '1.87.0' },
  ]),
).toThrow('OCR_RUNTIME_NOTICES_INVALID');

expect(() => findOcrRuntimeDependency('msys2', 'giflib', '0', [])).toThrow(
  'OCR_RUNTIME_NOTICES_INVALID',
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the schema and exact lookup**

```js
export function findOcrRuntimeDependency(provider, name, version, inventory) {
  assertPinnedOcrRuntimeDependencyInventory(inventory);
  const entry = inventory.find(
    (candidate) =>
      candidate.provider === provider && candidate.name === name && candidate.version === version,
  );
  if (!entry) throw noticesError();
  return entry;
}
```

Validate every record before freezing the exported inventory.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/ocr-runtime-dependency-inventory.mjs scripts/release/test/ocr-runtime-dependency-inventory.test.ts
git commit -m "feat(release): validate OCR dependency inventory"
```

### Task 2: Verified native notice extraction

**Files:**

- Modify: `scripts/release/build-native-ocr-runtime.ps1`
- Modify: `scripts/release/build-native-ocr-runtime.sh`
- Modify: `scripts/release/test/build-ocr-runtime.test.ts`

**Interfaces:**

- Consumes `findOcrRuntimeDependency` from Task 1.
- Produces one verified notice section per provider/version.

- [ ] **Step 1: Write failing native-builder assertions**

```ts
expect(windowsBuilder).toContain('findOcrRuntimeDependency');
expect(macosBuilder).toContain('brew which-formula');
expect(windowsBuilder).not.toContain('/share/licenses/');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts`

Expected: FAIL because both builders scan package-manager documentation directories.

- [ ] **Step 3: Implement verified extraction**

For every provider/version, call Node with the shared module, download `sourceUrl`, verify
`sourceSha256`, extract `licensePath`, verify `licenseSha256`, and append raw text plus record
metadata. Windows obtains provider/version with `pacman -Qo` and `pacman -Q`; macOS obtains
them with `brew which-formula` and `brew info --json=v2 --installed`.

- [ ] **Step 4: Run static native-builder validation**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts`

Expected: PASS.

Run: `C:\Program Files\Git\bin\bash.exe -n scripts/release/build-native-ocr-runtime.sh`

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/build-native-ocr-runtime.ps1 scripts/release/build-native-ocr-runtime.sh scripts/release/test/build-ocr-runtime.test.ts
git commit -m "fix(release): verify native runtime license notices"
```

### Task 3: Exact provider inventory

**Files:**

- Modify: `scripts/release/ocr-runtime-dependency-inventory.mjs`
- Modify: `scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

**Interfaces:**

- Consumes the provider/version diagnostics emitted by Task 2.
- Produces complete immutable records for all libraries copied by Windows and both macOS runners.

- [ ] **Step 1: Dispatch native diagnostics**

Run: `gh workflow run "Build OCR runtime artifacts" --ref codex/official-catalog-image-ocr`

Expected: native jobs report every copied library and its provider/version before rejecting an
unmapped record.

- [ ] **Step 2: Add a failing completeness test**

```ts
for (const expected of expectedProviders) {
  expect(
    findOcrRuntimeDependency(expected.provider, expected.name, expected.version),
  ).toMatchObject(expected);
}
```

- [ ] **Step 3: Add immutable source records**

Each record uses an upstream release or tag URL containing the recorded version, archive SHA-256,
license path, extracted license SHA-256, and SPDX identifier. Do not use mutable branches,
`latest` URLs, or package-manager URLs.

- [ ] **Step 4: Verify locally**

Run: `npm test -- --run scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/ocr-runtime-dependency-inventory.mjs scripts/release/test/ocr-runtime-dependency-inventory.test.ts
git commit -m "feat(release): pin native OCR dependency notices"
```

### Task 4: Matrix and release-gate verification

**Files:**

- Modify only if diagnostics show a deterministic workflow issue: `.github/workflows/build-ocr-runtime.yml`

- [ ] **Step 1: Run local verification**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: PASS.

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 2: Push and run the native matrix**

Run: `git push origin codex/official-catalog-image-ocr`

Run: `gh workflow run "Build OCR runtime artifacts" --ref codex/official-catalog-image-ocr`

Expected: Windows, Linux, macOS ARM64, and macOS x64 upload artifacts successfully.

- [ ] **Step 3: Inspect every job**

Run: `gh run view <run-id> --json status,conclusion,jobs,url`

Expected: run conclusion `success`; each job and artifact upload conclusion `success`.
