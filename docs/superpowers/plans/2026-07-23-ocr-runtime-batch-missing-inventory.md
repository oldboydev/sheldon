# OCR Runtime Batch Missing Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report every missing native OCR dependency notice record in one stable diagnostic before native builders download any dependency notice source.

**Architecture:** The shared inventory gets a validated non-throwing exact lookup and a formatter for sorted identities. Each native builder resolves its full private-library ownership graph, then performs a complete lookup pass and emits a single missing block if any identity is unpinned. Notice downloads and current hash/license validation run only after that pass succeeds.

**Tech Stack:** Node.js ESM, Vitest, PowerShell, Bash, MSYS2 pacman, Homebrew.

## Global Constraints

- Scope is Windows/MSYS2 and macOS/Homebrew native OCR builders only.
- Emit `OCR_RUNTIME_DEPENDENCY` for every resolved unique package identity.
- The missing diagnostic is `OCR_RUNTIME_MISSING_DEPENDENCIES`, with lexical `provider/name@version` lines.
- Missing records fail non-zero before any dependency notice source download.
- Preserve fail-closed inventory, source hash, license path, license text, and license hash validation; never auto-generate records.
- Do not publish or tag a catalog or release artifact.

---

### Task 1: Shared batch lookup and deterministic missing formatter

**Files:**

- Modify: `scripts/release/ocr-runtime-dependency-inventory.mjs`
- Modify: `scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

**Interfaces:**

- Produces `findPinnedOcrRuntimeDependency(provider, name, version, inventory): object | undefined` after validating `inventory`.
- Produces `formatMissingOcrRuntimeDependencies(identities): string`.
- Keeps `findOcrRuntimeDependency(...)` throwing `OCR_RUNTIME_NOTICES_INVALID` when the exact record is absent.

- [ ] **Step 1: Write failing lookup/formatter tests**

```ts
expect(findPinnedOcrRuntimeDependency('homebrew', 'giflib', '6.1.3', [])).toBeUndefined();
expect(
  formatMissingOcrRuntimeDependencies([
    { provider: 'msys2', name: 'zlib', version: '1' },
    { provider: 'homebrew', name: 'giflib', version: '6' },
    { provider: 'msys2', name: 'zlib', version: '1' },
  ]),
).toBe('OCR_RUNTIME_MISSING_DEPENDENCIES:\\nhomebrew/giflib@6\\nmsys2/zlib@1');
```

- [ ] **Step 2: Run the focused test (red)**

Run: `npm test -- --run scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: FAIL because the batch exports do not exist.

- [ ] **Step 3: Implement validated lookup and formatting (green)**

```js
export function findPinnedOcrRuntimeDependency(provider, name, version, inventory) {
  assertPinnedOcrRuntimeDependencyInventory(inventory);
  return inventory.find(
    (entry) => entry.provider === provider && entry.name === name && entry.version === version,
  );
}
```

Use a `Set` of rendered identities, lexically sort only its lines, prefix them with the unchanged header, and have the existing throwing lookup use the new exact lookup.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/ocr-runtime-dependency-inventory.mjs scripts/release/test/ocr-runtime-dependency-inventory.test.ts
git commit -m "feat(release): format missing OCR dependency inventory"
```

### Task 2: Batch-validate Windows MSYS2 identities

**Files:**

- Modify: `scripts/release/build-native-ocr-runtime.ps1`
- Modify: `scripts/release/test/build-ocr-runtime.test.ts`

**Interfaces:**

- Consumes Task 1 functions and the full pacman package identity set.
- Produces a full missing report before `Get-VerifiedDependencyNotice` downloads a source archive.

- [ ] **Step 1: Write the failing static harness assertion**

```ts
expect(windowsBuilder).toContain('findPinnedOcrRuntimeDependency');
expect(windowsBuilder).toContain('OCR_RUNTIME_MISSING_DEPENDENCIES');
expect(windowsBuilder.indexOf('OCR_RUNTIME_MISSING_DEPENDENCIES')).toBeLessThan(
  windowsBuilder.indexOf('Get-VerifiedDependencyNotice'),
);
```

- [ ] **Step 2: Run the focused test (red)**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts`

Expected: FAIL because the builder materializes notices as it resolves records.

- [ ] **Step 3: Implement the complete preflight (green)**

Pass every resolved MSYS2 package name/version to a Node command. It validates inventory, prints every `OCR_RUNTIME_DEPENDENCY`, accumulates missing identities, and prints the Task 1 formatter result with non-zero status when nonempty. PowerShell must throw that output before calling `Get-VerifiedDependencyNotice`; only a complete successful record set enters the existing materialization loop.

- [ ] **Step 4: Run focused test and parse validation**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts`

Expected: PASS.

Run: `powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw scripts/release/build-native-ocr-runtime.ps1))"`

Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/build-native-ocr-runtime.ps1 scripts/release/test/build-ocr-runtime.test.ts
git commit -m "fix(release): batch missing MSYS2 notice records"
```

### Task 3: Batch-validate macOS Homebrew identities and run release verification

**Files:**

- Modify: `scripts/release/build-native-ocr-runtime.sh`
- Modify: `scripts/release/test/build-ocr-runtime.test.ts`

**Interfaces:**

- Consumes Task 1 functions and the complete Homebrew identity arrays.
- Preserves the existing verified notice renderer after the preflight succeeds.

- [ ] **Step 1: Write the failing static harness assertion**

```ts
expect(macosBuilder).toContain('findPinnedOcrRuntimeDependency');
expect(macosBuilder).toContain('OCR_RUNTIME_MISSING_DEPENDENCIES');
expect(macosBuilder.indexOf('OCR_RUNTIME_MISSING_DEPENDENCIES')).toBeLessThan(
  macosBuilder.indexOf('download_pinned "$source_url"'),
);
```

- [ ] **Step 2: Run the focused test (red)**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts`

Expected: FAIL because Homebrew downloads a source in its first lookup loop.

- [ ] **Step 3: Implement the complete Homebrew preflight (green)**

Pass all resolved Homebrew names and versions to a Node command that validates inventory, writes every dependency diagnostic, and either exits with the deterministic missing block or returns every record. Read those records into Bash arrays, then run the existing pinned-source/license rendering loop unchanged.

- [ ] **Step 4: Run focused, syntax, and repository verification**

Run: `npm test -- --run scripts/release/test/build-ocr-runtime.test.ts scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

Expected: PASS.

Run: `bash -n scripts/release/build-native-ocr-runtime.sh`

Expected: exit code 0.

Run: `npm run verify`

Expected: PASS.

- [ ] **Step 5: Commit, push, and inspect native matrix**

```bash
git add scripts/release/build-native-ocr-runtime.sh scripts/release/test/build-ocr-runtime.test.ts
git commit -m "fix(release): batch missing Homebrew notice records"
git push origin codex/official-catalog-image-ocr
gh workflow run "Build OCR runtime artifacts" --ref codex/official-catalog-image-ocr
gh run view <run-id> --json status,conclusion,jobs,url
```

Expected: native Windows, Linux, macOS ARM64, and macOS x64 jobs succeed. Do not publish, sign, or tag a catalog.
