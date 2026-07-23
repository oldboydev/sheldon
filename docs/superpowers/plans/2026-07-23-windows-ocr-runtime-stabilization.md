# Windows OCR Runtime Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows OCR runtime build reproducible and diagnosable by validating a committed full MSYS2 installed-package graph before build work, while keeping dependency notices manual and fail-closed.

**Architecture:** Keep PowerShell as the Windows toolchain orchestrator, but move deterministic graph parsing, graph-lock validation, inventory preflight, pinned HTTP transport, and license rendering into a Windows-specific Node module and thin CLI. The GitHub workflow provisions a clean, explicitly configured MSYS2 installation; portable Vitest suites exercise every seam locally without MSYS2, and the hosted Windows job alone confirms the real package graph, toolchain, and artifact.

**Tech Stack:** Node.js 24 ESM, Vitest 4, PowerShell 7, MSYS2 MINGW64/pacman, GitHub Actions, JSON, SHA-256.

## Global Constraints

- Scope is Windows `win32-x64` only; do not modify `scripts/release/build-native-ocr-runtime.sh` or any macOS behavior, dependency, test harness, or workflow branch.
- Commit `scripts/release/msys2-ocr-runtime.lock.json` as the complete lexical `pacman -Q` result from the exact MSYS2 installation used by the hosted Windows build.
- Validate the complete installed graph before downloading Tesseract, models, or dependency sources and before running CMake.
- Keep `msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884` and make `release: true`, `update: false`, and `cache: false` explicit.
- `release: true` deliberately starts from the action's fresh installer release; `update: false` deliberately avoids mutating that snapshot with a full system update; `cache: false` deliberately prevents restored package state from bypassing graph-lock validation.
- A changed MSYS2 release or repository graph must fail closed with the complete sorted installed graph and a deterministic missing/unexpected/version-changed diff; it must never rewrite the lock.
- `scripts/release/ocr-runtime-dependency-inventory.mjs` remains human-authored. Unknown runtime package identities, source hashes, license paths, license hashes, or license texts remain hard failures and must never be inferred or generated.
- Every HTTP attempt verifies the same caller-supplied SHA-256 before atomic promotion. Redirects and retries never weaken or replace the expected checksum.
- Allow at most 3 HTTP attempts, 5 redirects per attempt, and 30 seconds per request. Retry only transport/timeout failures, HTTP 408/429/500/502/503/504, and checksum mismatches.
- Allow only HTTPS source and redirect URLs. Never log credentials, query strings, or fragments.
- Preserve current Tesseract source/model pins, artifact layout, `eng`/`por` health check, and private-DLL discovery.
- Do not create generated inventory or lock updates, sign a catalog, run the publishing workflow, create a tag, upload a release, or change release publication conditions.
- Local verification must not require MSYS2. Use fake `pacman -Q` text, temporary extracted-source trees, injected fetch/sleep functions, and local HTTP servers.
- Hosted CI is used only to capture/confirm the real Windows package graph and to confirm the real Windows toolchain/artifact.

---

## File Structure

| File                                                            | Responsibility                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/release/msys2-ocr-runtime.lock.json`                   | Human-reviewed setup semantics, requested root packages, and complete exact installed MSYS2 package graph.                        |
| `scripts/release/windows-ocr-runtime.mjs`                       | Portable Windows-only graph, inventory, download, checksum, license verification, and notice-rendering library.                   |
| `scripts/release/windows-ocr-runtime-cli.mjs`                   | Strict stdin/argument adapter used by PowerShell; no package-manager or workflow mutations.                                       |
| `scripts/release/test/windows-ocr-runtime.test.ts`              | Platform-neutral unit/integration tests for all extracted Windows seams.                                                          |
| `scripts/release/build-native-ocr-runtime.ps1`                  | Real Windows toolchain orchestration, DLL traversal/copying, CLI calls, and health check.                                         |
| `scripts/release/test/build-ocr-runtime.test.ts`                | Workflow/builder wiring assertions; remove source-slicing harnesses superseded by public module tests.                            |
| `.github/workflows/build-ocr-runtime.yml`                       | Explicit clean MSYS2 provisioning and real Windows artifact confirmation.                                                         |
| `scripts/release/ocr-runtime-dependency-inventory.mjs`          | Existing manually maintained runtime notice records; edit only when the accepted graph exposes an exact missing runtime identity. |
| `scripts/release/test/ocr-runtime-dependency-inventory.test.ts` | Existing inventory schema/exact-record coverage; add exact assertions only for manually reviewed record changes.                  |

## Stable Interfaces and Diagnostics

`scripts/release/windows-ocr-runtime.mjs` exports:

```js
export const MSYS2_GRAPH_SCHEMA_VERSION = 1;

export function parseMsys2PackageGraph(stdout) {}
// -> ReadonlyArray<{ name: string, version: string }>

export function validateMsys2GraphLock(lock) {}
// -> normalized frozen lock or throws OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID

export function assertPinnedMsys2PackageGraph(installed, lock) {}
// -> void or throws OCR_RUNTIME_MSYS2_GRAPH_INVALID with the complete graph and diff

export function preflightMsys2RuntimeDependencies(identities, inventory) {}
// -> { dependencies: readonly object[], diagnostics: readonly string[] }
// or throws the existing OCR_RUNTIME_MISSING_DEPENDENCIES report

export async function downloadPinnedFile(options) {}
// options: {
//   url, destination, expectedSha256,
//   fetchImpl = globalThis.fetch, sleep = setTimeout-backed Promise,
//   onDiagnostic = () => {}, maxAttempts = 3, maxRedirects = 5,
//   requestTimeoutMs = 30_000
// }
// -> { finalUrl: string, sha256: string, attempts: number }

export async function renderVerifiedMsys2DependencyNotice(options) {}
// options: { dependency, privateDlls, extractedRoot }
// -> exact notice section string
```

`scripts/release/windows-ocr-runtime-cli.mjs` accepts exactly:

```text
node scripts/release/windows-ocr-runtime-cli.mjs graph-lock --lock scripts/release/msys2-ocr-runtime.lock.json
node scripts/release/windows-ocr-runtime-cli.mjs dependency-preflight
node scripts/release/windows-ocr-runtime-cli.mjs download --url URL --output PATH --sha256 HASH
node scripts/release/windows-ocr-runtime-cli.mjs dependency-notice
```

- `graph-lock` reads raw `pacman -Q` text from stdin.
- `dependency-preflight` reads a JSON array of MSYS2 identities from stdin and writes one JSON result to stdout.
- `download` writes transport diagnostics to stderr and no success payload to stdout.
- `dependency-notice` reads `{ dependency, privateDlls, extractedRoot }` JSON from stdin and writes the verified notice section to stdout.
- Unknown commands, repeated/missing switches, non-JSON input, and extra positional arguments fail with `OCR_RUNTIME_ARGUMENTS_INVALID`.

Stable transport diagnostics use sanitized URLs:

```text
OCR_RUNTIME_DOWNLOAD_REDIRECT: attempt=1 hop=1/5 status=302 from=https://example.test/source to=https://cdn.example.test/source
OCR_RUNTIME_DOWNLOAD_RETRY: attempt=1/3 reason=http-503 url=https://example.test/source
OCR_RUNTIME_DOWNLOAD_RETRY: attempt=2/3 reason=checksum-mismatch url=https://example.test/source
```

The graph failure starts with this exact marker and prints all sections lexically:

```text
OCR_RUNTIME_MSYS2_GRAPH_INVALID:
installed:
- bash@5.2.037-2
- mingw-w64-x86_64-zlib@1.3.2-2
missing:
- expected-only@1.0.0-1
unexpected:
- installed-only@2.0.0-1
changed:
- mingw-w64-x86_64-zlib expected=1.3.2-1 installed=1.3.2-2
```

Empty sections are omitted. The complete `installed:` section is always present so a maintainer can review and manually transcribe a new lock without a generator.

---

### Task 1: Extract and test MSYS2 graph-lock validation

**Files:**

- Create: `scripts/release/windows-ocr-runtime.mjs`
- Create: `scripts/release/test/windows-ocr-runtime.test.ts`

**Interfaces:**

- Consumes raw `pacman -Q` output and a JSON-compatible lock object.
- Produces `MSYS2_GRAPH_SCHEMA_VERSION`, `parseMsys2PackageGraph`, `validateMsys2GraphLock`, and `assertPinnedMsys2PackageGraph`.

- [ ] **Step 1: Write failing parser and schema tests**

Add tests with this concrete fixture:

```ts
const setup = {
  action: 'msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
  msystem: 'MINGW64',
  release: true,
  update: false,
  cache: false,
  install: [
    'mingw-w64-x86_64-cmake',
    'mingw-w64-x86_64-gcc',
    'mingw-w64-x86_64-leptonica',
    'mingw-w64-x86_64-ninja',
    'mingw-w64-x86_64-pkgconf',
  ],
};

it('parses and sorts a complete pacman graph', () => {
  expect(parseMsys2PackageGraph('mingw-w64-x86_64-zlib 1.3.2-2\nbash 5.2.037-2\n')).toEqual([
    { name: 'bash', version: '5.2.037-2' },
    { name: 'mingw-w64-x86_64-zlib', version: '1.3.2-2' },
  ]);
});

it.each(['', 'bash', 'bash 1 extra', 'bash 1\nbash 1\n', 'bad/name 1\n'])(
  'rejects malformed or duplicate pacman output: %j',
  (stdout) => {
    expect(() => parseMsys2PackageGraph(stdout)).toThrow('OCR_RUNTIME_MSYS2_GRAPH_INVALID');
  },
);
```

Test that the lock rejects an unknown key, wrong schema version, non-lexical packages, duplicate names, missing requested root packages, nonboolean setup flags, and an empty package list with `OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts
```

Expected: FAIL because the Windows runtime module and exports do not exist.

- [ ] **Step 3: Implement strict parsing and lock validation**

Use exact package-name syntax `/^[A-Za-z0-9@._+:-]+$/u`, require exactly one ASCII-space-delimited version, normalize CRLF, reject blank interior lines, and sort with `localeCompare(..., 'en')`. Require the lock shape:

```json
{
  "schemaVersion": 1,
  "setup": {
    "action": "msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884",
    "msystem": "MINGW64",
    "release": true,
    "update": false,
    "cache": false,
    "install": [
      "mingw-w64-x86_64-cmake",
      "mingw-w64-x86_64-gcc",
      "mingw-w64-x86_64-leptonica",
      "mingw-w64-x86_64-ninja",
      "mingw-w64-x86_64-pkgconf"
    ]
  },
  "packages": [
    {
      "name": "bash",
      "version": "5.2.037-2"
    }
  ]
}
```

The one-package document is a test fixture, not the committed production lock.

- [ ] **Step 4: Add deterministic full-diff tests**

Assert exact installed, missing, unexpected, and changed sections. Add a matching-graph case that returns without output and a mismatch case in which version changes appear only in `changed`, not also in missing/unexpected.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts
git diff --check
git add scripts/release/windows-ocr-runtime.mjs scripts/release/test/windows-ocr-runtime.test.ts
git commit -m "refactor(release): extract MSYS2 graph validation"
```

Expected: the focused suite passes and only the two task files are committed.

**Review gate:** Reject the task if malformed/duplicate input is normalized silently, if lock comparison checks only runtime DLL owners, or if any function writes a lock file.

---

### Task 2: Add checksum-preserving bounded transport

**Files:**

- Modify: `scripts/release/windows-ocr-runtime.mjs`
- Modify: `scripts/release/test/windows-ocr-runtime.test.ts`

**Interfaces:**

- Consumes an HTTPS URL, destination, exact lowercase/uppercase SHA-256, injected fetch/sleep/diagnostic callbacks, and fixed bounds.
- Produces `downloadPinnedFile(options)` and leaves no partial file after failure.

- [ ] **Step 1: Write failing atomic-download tests**

Use an injected `fetchImpl` and temporary destination. Cover:

```ts
it('retries a corrupt body but promotes only checksum-matching bytes', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response('corrupt', { status: 200 }))
    .mockResolvedValueOnce(new Response('verified', { status: 200 }));
  const diagnostics: string[] = [];

  await downloadPinnedFile({
    url: 'https://example.test/source',
    destination,
    expectedSha256: sha256('verified'),
    fetchImpl,
    sleep: async () => {},
    onDiagnostic: (line) => diagnostics.push(line),
  });

  await expect(readFile(destination, 'utf8')).resolves.toBe('verified');
  expect(diagnostics).toContain(
    'OCR_RUNTIME_DOWNLOAD_RETRY: attempt=1/3 reason=checksum-mismatch url=https://example.test/source',
  );
});
```

Also prove that three corrupt responses fail `OCR_RUNTIME_CHECKSUM_INVALID`, preserve an existing destination byte-for-byte, and leave no `.partial` sibling.

- [ ] **Step 2: Write failing redirect/retry policy tests**

Cover exactly:

- 302 then 200 succeeds and emits one redirect diagnostic.
- A sixth redirect fails `OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID`.
- HTTP-to-HTTPS and HTTPS-to-HTTP redirects fail; the initial non-HTTPS URL fails before fetch.
- 408, 429, 500, 502, 503, and 504 retry; 400, 401, 403, and 404 do not.
- An injected abort/transport error retries exactly three times.
- URL diagnostics strip username, password, query, and fragment.
- Every retry starts with the original URL and still checks the original expected hash.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts
```

Expected: FAIL because `downloadPinnedFile` is absent.

- [ ] **Step 4: Implement the bounded state machine**

Use `fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })`, recognize only 301/302/303/307/308 as redirects, resolve `Location` with `new URL`, and reject a missing/invalid/non-HTTPS target. Buffer each response to a unique same-directory partial path, calculate SHA-256, and rename only after equality. In `finally`, remove the partial path with `{ force: true }`.

Use delays of 250 ms and 500 ms before attempts 2 and 3. The injected `sleep` makes tests instantaneous. Treat a checksum mismatch as retryable until the third attempt, but never promote mismatched bytes.

- [ ] **Step 5: Run focused tests and commit**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts
git diff --check
git add scripts/release/windows-ocr-runtime.mjs scripts/release/test/windows-ocr-runtime.test.ts
git commit -m "fix(release): bound pinned Windows downloads"
```

Expected: transport tests pass without network access.

**Review gate:** Reject the task if fetch follows redirects automatically, any retry changes/omits `expectedSha256`, a failed attempt truncates a pre-existing destination, bounds are caller-unlimited, or diagnostics expose URL secrets.

---

### Task 3: Extract inventory preflight and verified license rendering

**Files:**

- Modify: `scripts/release/windows-ocr-runtime.mjs`
- Modify: `scripts/release/test/windows-ocr-runtime.test.ts`

**Interfaces:**

- Consumes discovered MSYS2 runtime identities, the existing inventory, extracted source roots, and copied DLL names.
- Produces `preflightMsys2RuntimeDependencies` and `renderVerifiedMsys2DependencyNotice`.

- [ ] **Step 1: Write failing preflight tests**

Reuse the existing inventory functions, but test the public Windows seam directly. Assert:

```ts
expect(() =>
  preflightMsys2RuntimeDependencies(
    [
      { provider: 'msys2', name: 'zlib', version: '2' },
      { provider: 'msys2', name: 'brotli', version: '1' },
    ],
    [],
  ),
).toThrow('OCR_RUNTIME_MISSING_DEPENDENCIES:\nmsys2/brotli@1\nmsys2/zlib@2');
```

Add singleton, empty, malformed, duplicate, non-MSYS2, exact-hit, and input-order-independent cases. Exact hits return dependencies in lexical package-name order and one `OCR_RUNTIME_DEPENDENCY` diagnostic per unique identity.

- [ ] **Step 2: Write failing license rendering tests**

Create a temporary extracted tree with `package/LICENSE`, pass a dependency whose license hash equals its bytes, and assert the exact current metadata/text order:

```text
== msys2 package: mingw-w64-x86_64-zlib@1.3.2-2 ==
Provider: msys2
Package: mingw-w64-x86_64-zlib
Version: 1.3.2-2
SPDX: Zlib
Source: https://example.test/zlib.tar.xz
Source SHA-256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Private DLLs: zlib1.dll

License SPDX: Zlib
License path: package/LICENSE
License SHA-256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

verified license text
```

Add zero/multiple suffix matches, path traversal, hash mismatch, empty text, duplicate DLL, and multiple-license ordering cases. Every failure uses `OCR_RUNTIME_NOTICES_INVALID`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts
```

Expected: FAIL because the two exports are absent.

- [ ] **Step 4: Implement the two pure seams**

Call `findPinnedOcrRuntimeDependency` and `formatMissingOcrRuntimeDependencies` from the existing inventory module. Validate all identities before lookup, collect all missing identities before throwing, and do no download or extraction.

For license rendering, require each normalized relative license path to resolve to exactly one regular file under `extractedRoot`; compare the exact SHA-256 and reject whitespace-only text. Preserve the existing notice labels so downstream artifact content does not change.

- [ ] **Step 5: Run both Windows and inventory tests and commit**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/ocr-runtime-dependency-inventory.test.ts
git diff --check
git add scripts/release/windows-ocr-runtime.mjs scripts/release/test/windows-ocr-runtime.test.ts
git commit -m "refactor(release): isolate Windows notice validation"
```

Expected: both suites pass; the inventory file itself is unchanged.

**Review gate:** Reject the task if preflight stops at the first missing identity, rendering scans arbitrary license names, SPDX text substitutes for a license file, or either seam reaches the network/package manager.

---

### Task 4: Add the strict CLI and slim the PowerShell builder

**Files:**

- Create: `scripts/release/windows-ocr-runtime-cli.mjs`
- Modify: `scripts/release/build-native-ocr-runtime.ps1`
- Modify: `scripts/release/test/windows-ocr-runtime.test.ts`
- Modify: `scripts/release/test/build-ocr-runtime.test.ts`

**Interfaces:**

- Consumes the four CLI contracts defined above and current PowerShell build state.
- Produces a builder that validates the full graph before its first download and uses no inline Node `--eval`.

- [ ] **Step 1: Write failing CLI subprocess tests**

Spawn Node with `shell: false`. Test valid fixture lock/input, missing lock, malformed stdin, every invalid argument shape, missing dependency batch output, pinned download against a local HTTP server, and notice rendering against a temporary extracted tree. Assert stdout remains machine-readable while diagnostics/errors use stderr and nonzero status.

- [ ] **Step 2: Write failing builder wiring assertions**

Replace `executeWindowsDependencyPreflight` source slicing with direct CLI tests. Assert the builder:

```ts
expect(builder).toContain("windows-ocr-runtime-cli.mjs' 'graph-lock'");
expect(builder).toContain("windows-ocr-runtime-cli.mjs' 'dependency-preflight'");
expect(builder).toContain("windows-ocr-runtime-cli.mjs' 'download'");
expect(builder).toContain("windows-ocr-runtime-cli.mjs' 'dependency-notice'");
expect(builder).not.toContain('node --input-type=module --eval');
expect(builder.indexOf("'graph-lock'")).toBeLessThan(builder.indexOf("'download'"));
expect(builder.indexOf("'graph-lock'")).toBeLessThan(builder.indexOf('cmake.exe'));
```

Retain assertions for `-DSW_BUILD=OFF`, `pacman -Qo`, `pacman -Q`, no `/share/licenses/`, private DLL traversal, and `eng`/`por`.

- [ ] **Step 3: Run the two suites and verify RED**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts
```

Expected: FAIL because the CLI is absent and PowerShell still embeds preflight/download/license logic.

- [ ] **Step 4: Implement the CLI**

Parse `process.argv.slice(2)` without shell interpolation. Read stdin with a bounded helper, import the library, serialize only the documented result, and set `process.exitCode = 1` after writing stable error text. The CLI never invokes pacman, tar, CMake, or a workflow API.

- [ ] **Step 5: Rewire PowerShell**

Immediately after resolving `$pacman`, run `& $pacman -Q`, require exit code zero/nonempty stdout, and pipe the raw text to:

```powershell
$windowsRuntimeCli = Join-Path $repositoryRoot 'scripts\release\windows-ocr-runtime-cli.mjs'
$graphLock = Join-Path $repositoryRoot 'scripts\release\msys2-ocr-runtime.lock.json'
$installedGraph | node $windowsRuntimeCli graph-lock --lock $graphLock
if ($LASTEXITCODE -ne 0) {
  throw 'OCR_RUNTIME_MSYS2_GRAPH_INVALID: Installed MSYS2 packages do not match the committed graph lock.'
}
```

Move this before `$workRoot` creation and before every `download`/CMake call. Replace `Get-PinnedFile` with the CLI download command and preserve its destination/hash inputs. Replace the inline inventory eval with `dependency-preflight`; replace only the license resolution/hash/rendering body with `dependency-notice`, leaving `tar` extraction in PowerShell.

Restore `$env:PATH` in `finally` around CMake and health-check mutations, including failure paths.

- [ ] **Step 6: Run portable tests and commit**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts scripts/release/test/ocr-runtime-dependency-inventory.test.ts
npm run typecheck
git diff --check
git add scripts/release/windows-ocr-runtime-cli.mjs scripts/release/build-native-ocr-runtime.ps1 scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts
git commit -m "refactor(release): modularize Windows OCR builder"
```

Expected: all portable tests pass on a host with no MSYS2. Directly running the full PowerShell builder is not a local gate.

**Review gate:** Reject the task if tests extract implementation text with regex, graph validation occurs after any network/build action, PowerShell loses existing error markers, or macOS files change.

---

### Task 5: Make setup-msys2 semantics explicit

**Files:**

- Modify: `.github/workflows/build-ocr-runtime.yml`
- Modify: `scripts/release/test/build-ocr-runtime.test.ts`

**Interfaces:**

- Consumes the pinned action and the lock's `setup` object.
- Produces an uncached fresh-release MINGW64 environment whose full graph is checked by Task 4.

- [ ] **Step 1: Write the failing YAML contract**

Load the workflow and assert the Windows setup step has:

```ts
expect(msys2Step).toMatchObject({
  uses: 'msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
  if: "matrix.platform == 'win32-x64'",
  with: {
    msystem: 'MINGW64',
    release: true,
    update: false,
    cache: false,
    install: expect.any(String),
  },
});
```

Split the whitespace-separated `install` value, sort it, and compare it to the lock's `setup.install`. Assert the Windows build still passes `steps.msys2.outputs.msys2-location`.

- [ ] **Step 2: Run the workflow test and verify RED**

Run:

```powershell
npm test -- --run scripts/release/test/build-ocr-runtime.test.ts
```

Expected: FAIL because `release` and `cache` currently rely on defaults.

- [ ] **Step 3: Set all three values explicitly**

Keep `update: false`, add `release: true` and `cache: false`, and add concise YAML comments documenting the Global Constraints semantics. Do not change the macOS/Linux setup or artifact upload.

- [ ] **Step 4: Run the workflow test**

Run:

```powershell
npm test -- --run scripts/release/test/build-ocr-runtime.test.ts
git diff --check
```

Expected: the workflow parses and the explicit setup contract passes.

Do not commit yet: Task 6 adds the production lock and commits workflow/lock together so the branch never finishes with unreviewed setup semantics.

**Review gate:** Reject the task if cache remains implicit/true, `update` becomes true, `release` becomes false, package installation moves into an ad hoc shell step, or action pins change.

---

### Task 6: Capture and manually commit the complete real graph

**Files:**

- Create: `scripts/release/msys2-ocr-runtime.lock.json`
- Modify: `.github/workflows/build-ocr-runtime.yml`
- Modify only if demanded by exact CI output: `scripts/release/ocr-runtime-dependency-inventory.mjs`
- Modify only with an inventory record change: `scripts/release/test/ocr-runtime-dependency-inventory.test.ts`

**Interfaces:**

- Consumes the hosted Windows job's complete `installed:` diagnostic and any later `OCR_RUNTIME_MISSING_DEPENDENCIES` report.
- Produces the reviewed production graph lock and, only when necessary, exact manually researched notice records.

- [ ] **Step 1: Create a discovery commit without a synthetic lock**

Commit Tasks 5's workflow together with the Task 4 builder/CLI state. The missing lock is deliberate for this one remote discovery run: `graph-lock` must emit `OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID` plus the complete parsed `installed:` graph and stop before download/build.

Run:

```powershell
git add .github/workflows/build-ocr-runtime.yml scripts/release/test/build-ocr-runtime.test.ts
git commit -m "ci(release): define clean MSYS2 setup semantics"
git status --short
```

Expected: only the user's unrelated files remain unstaged.

- [ ] **Step 2: Run the no-publication workflow on the implementation branch**

After the branch is available on GitHub, run:

```powershell
$branchName = git branch --show-current
gh workflow run build-ocr-runtime.yml --ref $branchName
$runId = gh run list --workflow build-ocr-runtime.yml --branch $branchName --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --exit-status
```

Expected: the Windows job fails at graph-lock validation, before `OCR_RUNTIME_DOWNLOAD_` diagnostics or CMake. The log contains the complete sorted installed graph. This is a discovery failure, not artifact confirmation. Do not invoke `release.yml`.

- [ ] **Step 3: Manually author the complete lock**

Copy every exact `name@version` line from the Windows `installed:` section into `packages` objects, preserving lexical name order. Add the exact `setup` object from Task 1. Do not use a script to write, update, or derive the file.

Run the local lock/schema and formatting checks:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts
npx prettier --check scripts/release/msys2-ocr-runtime.lock.json
```

Expected: the lock is nonempty, unique, lexical, includes all five requested root packages, and matches the workflow setup contract.

- [ ] **Step 4: Re-run CI to expose runtime-only inventory drift**

Commit and run the same no-publication workflow:

```powershell
git add scripts/release/msys2-ocr-runtime.lock.json
git commit -m "build(release): lock installed MSYS2 package graph"
$branchName = git branch --show-current
gh workflow run build-ocr-runtime.yml --ref $branchName
$runId = gh run list --workflow build-ocr-runtime.yml --branch $branchName --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --exit-status
```

Expected: graph validation passes. The next acceptable failure is the existing complete `OCR_RUNTIME_MISSING_DEPENDENCIES` block after private-DLL discovery and before dependency source downloads.

- [ ] **Step 5: Manually reconcile exact runtime inventory records when required**

For each identity in that one fail-closed block:

1. Confirm from `pacman -Qo`/`pacman -Q` log evidence that the package owns a copied private DLL.
2. Locate the immutable upstream archive for that exact version from the MSYS2 package recipe/source references.
3. Download that archive manually, compute its SHA-256, extract it, select every license file required by the package's declared expression, compute each license SHA-256, and read every text.
4. Add one exact record to `OCR_RUNTIME_DEPENDENCY_INVENTORY`; do not add build-only graph packages.
5. Add an exact test assertion for provider/name/version/source hash/license paths/license hashes/SPDX.
6. Have a human reviewer compare the hashes and license expression with the upstream archive before re-running CI.

If CI reports no missing runtime identity, leave both inventory files byte-for-byte unchanged.

Run:

```powershell
npm test -- --run scripts/release/test/ocr-runtime-dependency-inventory.test.ts scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts
git diff --check
```

If records changed, commit only those two files:

```powershell
git add scripts/release/ocr-runtime-dependency-inventory.mjs scripts/release/test/ocr-runtime-dependency-inventory.test.ts
git commit -m "fix(release): pin current MSYS2 runtime notices"
```

**Review gate:** Reject the task if the graph was captured from a developer installation, the lock omits base/build packages, any lock/inventory content was generated, a source/license hash is copied without independent verification, or a build-only package enters the notice inventory.

---

### Task 7: Confirm the real Windows toolchain and artifact

**Files:**

- No source changes expected.

**Interfaces:**

- Consumes the final branch and reusable `build-ocr-runtime.yml`.
- Produces CI evidence for graph match, build, health check, notices, and uploaded Windows artifact.

- [ ] **Step 1: Run all portable release tests**

Run:

```powershell
npm test -- --run scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts scripts/release/test/ocr-runtime-dependency-inventory.test.ts scripts/release/test/release-workflow.test.ts
npm run typecheck
npx prettier --check scripts/release/windows-ocr-runtime.mjs scripts/release/windows-ocr-runtime-cli.mjs scripts/release/build-native-ocr-runtime.ps1 scripts/release/msys2-ocr-runtime.lock.json scripts/release/test/windows-ocr-runtime.test.ts scripts/release/test/build-ocr-runtime.test.ts .github/workflows/build-ocr-runtime.yml
npx markdownlint-cli2 docs/superpowers/plans/2026-07-23-windows-ocr-runtime-stabilization.md
git diff --check
```

Expected: all commands pass without MSYS2.

- [ ] **Step 2: Confirm scope**

Run:

```powershell
git diff --name-only HEAD~6..HEAD
git diff -- scripts/release/build-native-ocr-runtime.sh
git diff -- .github/workflows/release.yml
git status --short
```

Expected: no macOS builder diff, no publication-workflow diff, and unrelated user files remain untouched.

- [ ] **Step 3: Run the final no-publication CI build**

Run:

```powershell
$branchName = git branch --show-current
gh workflow run build-ocr-runtime.yml --ref $branchName
$runId = gh run list --workflow build-ocr-runtime.yml --branch $branchName --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --exit-status
gh run download $runId --name ocr-runtime-win32-x64 --dir .tmp/ocr-runtime-win32-x64
```

Expected: the `win32-x64` job validates the full graph before its first download, builds successfully, lists `eng` and `por`, and uploads `ocr-runtime-win32-x64`. The workflow does not sign, publish, tag, or create a release.

- [ ] **Step 4: Inspect the downloaded Windows artifact**

Run:

```powershell
Get-ChildItem -Recurse -File .tmp\ocr-runtime-win32-x64 | Sort-Object FullName | Select-Object FullName,Length
Get-Content -Raw .tmp\ocr-runtime-win32-x64\runtime\win32-x64\THIRD_PARTY_NOTICES
```

Expected: the canonical tree contains `runtime/win32-x64/tesseract.exe`, at least one private DLL under `runtime/win32-x64/lib`, nonempty `THIRD_PARTY_NOTICES`, and `data/tessdata/eng.traineddata` plus `por.traineddata`. Notices contain one verified package section for every private-DLL owner.

- [ ] **Step 5: Record final evidence without changing release state**

Record the run URL, Windows job conclusion, graph-lock commit, exact artifact file list, and focused test counts in the implementation handoff. Do not run `release.yml`, `sign:official-catalog`, `build:official-release`, or any tag/release command.

**Review gate:** The work is complete only when portable tests pass and hosted Windows CI produces the inspected artifact. A green local suite alone cannot prove MSYS2/toolchain correctness; a CI graph mismatch must result in a new human-reviewed lock change, never a bypass.

---

## Requirement-to-Task Traceability

| Approved requirement                                    | Tasks                       |
| ------------------------------------------------------- | --------------------------- |
| Windows-only scope; no macOS changes                    | Global Constraints, 4, 5, 7 |
| Committed complete MSYS2 installed-package graph        | 1, 4, 6                     |
| Validate graph before build/download                    | 1, 4, 7                     |
| Explicit setup-msys2 release/update/cache semantics     | 5, 6                        |
| Locally testable graph/preflight/download/license seams | 1, 2, 3, 4                  |
| Strict checksum-preserving bounded retries/redirects    | 2, 4                        |
| Manual inventory and fail-closed validation             | 3, 6                        |
| CI only for real graph/toolchain/artifact confirmation  | 6, 7                        |
| No generation, publication, signing, or tagging         | Global Constraints, 6, 7    |
| Local environment has no MSYS2                          | Global Constraints, 1-5, 7  |

Self-review completed: every approved requirement maps to a task; interface names and diagnostic markers are consistent across module, CLI, PowerShell, and tests; the only remote actions are manual runs of the non-publishing OCR artifact workflow; and no task changes macOS or weakens source/license/checksum validation.
