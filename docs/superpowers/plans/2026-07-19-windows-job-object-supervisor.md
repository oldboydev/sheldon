# Windows Job Object Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Windows plugin execution run beneath a kill-on-close Job Object so timeout and cancellation terminate descendants even after the direct plugin process exits.

**Architecture:** A small private N-API addon assigns a freshly started Node supervisor to a Windows Job Object before the supervisor spawns one plugin child. The supervisor forwards the child's stdio transparently, so `PluginProcessRunner` retains a normal `ChildProcess` interface while killing the supervisor closes the Job Object and its complete tree.

**Tech Stack:** Node.js 24, TypeScript 6 ESM, N-API C++, node-gyp, MSVC Build Tools, Windows Job Objects, SWC, Vitest.

## Global Constraints

- Keep Node.js `>=24`, TypeScript ESM with `moduleResolution: NodeNext`, SWC builds, and Vitest as the test runner.
- The addon is private `@sheldon/plugin-host` infrastructure; the JSONL protocol and `@sheldon/plugin-sdk` public API do not change.
- On Windows, initialize `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` for the supervisor before spawning any plugin command; never silently fall back to direct spawning.
- The addon must use stable N-API C headers only and expose one operation: initialize Job Object ownership for the current process.
- Supervisor forwarding must preserve stdin/stdout/stderr bytes and start the plugin with `shell: false`, the sanitized environment, and the plugin root as `cwd`.
- If the Windows addon cannot load or initialize, fail before starting the plugin with `PLUGIN_SUPERVISOR_UNAVAILABLE`.
- Linux and macOS retain direct spawn and do not claim a process-tree guarantee.
- Source Windows builds require matching Node headers, Python, MSVC Build Tools with C++ workload, and Windows SDK; packaged Windows output includes the matching private `.node` artifact.
- Preserve the coverage gate: 80% statements, functions, and lines; 70% branches.

---

### Task 1: Build the private Windows Job Object addon

**Files:**

- Create: `packages/plugin-host/native/windows-job/binding.gyp`
- Create: `packages/plugin-host/native/windows-job/src/job-object.cc`
- Create: `packages/plugin-host/src/windows-job-addon.ts`
- Create: `packages/plugin-host/test/windows-job-addon.test.ts`
- Modify: `packages/plugin-host/package.json`
- Modify: `package.json`
- Modify: `scripts/build.mjs`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: Node's N-API C headers, Windows `CreateJobObjectW`, `SetInformationJobObject`, and `AssignProcessToJobObject`.
- Produces: `initializeWindowsJob(): void`, loaded only on Windows; root `build:native:win32` command; generated `native/windows-job/build/Release/sheldon_job_object.node`.

- [ ] **Step 1: Write the failing loader and build-contract tests**

Create `windows-job-addon.test.ts` with an injectable loader path. The Windows test proves a missing binary becomes the stable host error before any plugin launch; the platform-neutral test proves non-Windows returns without loading native code:

```ts
it('does not load the Windows addon on non-Windows platforms', () => {
  expect(() => initializeWindowsJob({ platform: 'linux', load: vi.fn() })).not.toThrow();
});

it.runIf(process.platform === 'win32')('reports an unavailable addon', () => {
  expect(() => initializeWindowsJob({ platform: 'win32', load: () => { throw new Error('missing'); } }))
    .toThrow(expect.objectContaining({ code: 'PLUGIN_SUPERVISOR_UNAVAILABLE' }));
});
```

Extend `scripts/build.test.ts` to assert the Windows-native command is declared and that `scripts/build.mjs` calls the package-local native build before compiling `packages/plugin-host/src`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run packages/plugin-host/test/windows-job-addon.test.ts scripts/build.test.ts`

Expected: FAIL because the loader and native build integration do not exist.

- [ ] **Step 3: Add the N-API source and node-gyp metadata**

Create `binding.gyp`:

```json
{
  "targets": [{
    "target_name": "sheldon_job_object",
    "sources": ["src/job-object.cc"],
    "defines": ["NAPI_VERSION=8"],
    "conditions": [["OS=='win'", { "libraries": ["-lkernel32"] }]]
  }]
}
```

In `job-object.cc`, implement `Initialize(napi_env, napi_callback_info)` to create a job, set `JOB_OBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags` to `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign `GetCurrentProcess()`, retain the job handle in static process-lifetime storage, and throw a N-API error with the Win32 error code if any call fails. Export only `initialize`.

- [ ] **Step 4: Implement the typed dynamic loader and build integration**

Implement the loader boundary:

```ts
export function initializeWindowsJob(
  options: { platform?: NodeJS.Platform; load?: () => { initialize(): void } } = {},
): void {
  if ((options.platform ?? process.platform) !== 'win32') return;
  try {
    const addon = options.load?.() ?? loadGeneratedAddon();
    addon.initialize();
  } catch (cause) {
    throw new PluginHostError('PLUGIN_SUPERVISOR_UNAVAILABLE',
      'The Windows plugin supervisor could not initialize its native Job Object.', '',
      'Rebuild the Windows-native Sheldon plugin host component for this Node architecture.', { cause });
  }
}
```

Use `createRequire(import.meta.url)` to load `../native/windows-job/build/Release/sheldon_job_object.node`. Add package script `build:native:win32` running `node-gyp rebuild --directory native/windows-job`; root `build:native:win32` delegates to the workspace; `scripts/build.mjs` runs it only when `process.platform === 'win32'` before SWC compilation. Add `native/**/build/` and `*.node` to `.gitignore`.

- [ ] **Step 5: Run focused verification and the Windows native build**

Run: `npx vitest run packages/plugin-host/test/windows-job-addon.test.ts scripts/build.test.ts`

Expected: PASS.

Run: `npm run build:native:win32`

Expected: on Windows, node-gyp emits `packages/plugin-host/native/windows-job/build/Release/sheldon_job_object.node`; on another platform, the command reports that the Windows artifact is unsupported without altering source files.

- [ ] **Step 6: Commit the addon foundation**

```powershell
git add package.json package-lock.json scripts/build.mjs scripts/build.test.ts .gitignore packages/plugin-host
git commit -m "build(plugin-host): add Windows job object addon"
```

### Task 2: Run one plugin through a transparent job-owning supervisor

**Files:**

- Create: `packages/plugin-host/src/windows-supervisor.ts`
- Create: `packages/plugin-host/src/process-launcher.ts`
- Create: `packages/plugin-host/test/windows-supervisor.test.ts`
- Modify: `packages/plugin-host/src/process-runner.ts`
- Modify: `packages/plugin-host/src/index.ts`

**Interfaces:**

- Consumes: `initializeWindowsJob()`, plugin manifest command/root, and the runner's sanitized environment.
- Produces: `startPluginProcess(plugin, temporaryDirectory, environment): ChildProcessWithoutNullStreams`; a supervisor entry point that accepts a JSON-encoded launch descriptor on `argv[2]`.

- [ ] **Step 1: Write failing supervisor transparency tests**

Create a fixture that echoes an input JSONL line to stdout and writes a fixed marker to stderr. Assert that `startPluginProcess` yields the same stdout/stderr bytes and exit code as direct execution. On Windows assert the spawned command is `process.execPath` with the compiled `windows-supervisor.js` entry point; on non-Windows assert the plugin executable is started directly.

```ts
const child = startPluginProcess(plugin, temporaryDirectory, process.env);
child.stdin.end('{"requestId":"fixture"}\n');
await expect(readAll(child.stdout)).resolves.toBe('{"requestId":"fixture"}\n');
await expect(readAll(child.stderr)).resolves.toBe('fixture-stderr\n');
```

Add a Windows-only case with an injected unavailable addon that asserts `startPluginProcess` throws `PLUGIN_SUPERVISOR_UNAVAILABLE` and the fixture marker file was not created.

- [ ] **Step 2: Run the supervisor tests and verify RED**

Run: `npx vitest run packages/plugin-host/test/windows-supervisor.test.ts`

Expected: FAIL because no launcher or supervisor exists.

- [ ] **Step 3: Implement the supervisor entry point**

`windows-supervisor.ts` parses a single JSON descriptor containing executable, separate arguments, cwd, and environment. It calls `initializeWindowsJob()` before `spawn`, then starts the plugin with:

```ts
spawn(descriptor.executable, descriptor.arguments, {
  cwd: descriptor.cwd,
  env: descriptor.environment,
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

Pipe supervisor stdin to child stdin, child stdout to supervisor stdout, and child stderr to supervisor stderr. On child close, end both supervisor output streams and set the same non-null exit code. If child spawn fails, write only a safe diagnostic to stderr and exit non-zero.

- [ ] **Step 4: Implement the host launcher and wire the runner**

`process-launcher.ts` receives the plugin, temporary directory, and sanitized environment. On `win32`, spawn `process.execPath` with the compiled supervisor path and a JSON descriptor; otherwise use the existing direct `spawn`. Move only spawn concerns from `process-runner.ts` into this function, retaining stderr-tail handling and all protocol/lifecycle policy in the runner. Export the launcher only as an internal test seam from `index.ts` if the existing test convention requires it.

- [ ] **Step 5: Run supervisor and existing process tests**

Run: `npx vitest run packages/plugin-host/test/windows-supervisor.test.ts packages/plugin-host/test/process-runner.test.ts`

Expected: PASS, including all existing process protocol and environment checks.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit supervisor integration**

```powershell
git add packages/plugin-host/src packages/plugin-host/test
git commit -m "feat(plugin-host): supervise Windows plugins with job objects"
```

### Task 3: Close lifecycle regressions and document the Windows guarantee

**Files:**

- Modify: `packages/plugin-host/src/process-tree.ts`
- Modify: `packages/plugin-host/src/process-runner.ts`
- Modify: `packages/plugin-host/test/process-lifecycle.test.ts`
- Modify: `packages/plugin-host/test/fixtures/exited-parent-tree.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-07-18-plugin-platform.md`

**Interfaces:**

- Consumes: supervisor-owned Windows Job Object from Task 2 and `PluginProcessRunner.ingest(..., { signal })`.
- Produces: bounded timeout/cancellation settlement after an exited plugin parent; Windows lifecycle evidence that no descendant or lease remains.

- [ ] **Step 1: Write the failing exited-parent regression**

Replace the fragile fixture with one that waits for a request, spawns a detached descendant with inherited stdout/stderr, awaits its `spawn` event, writes its PID to the supplied file, then exits. The descendant self-terminates after 15 seconds as a crash safeguard.

In the Windows test, create an `AbortController`, start `runner.ingest`, immediately enter a `try/finally`, wait up to 5 seconds for the PID file, abort the operation, and assert:

```ts
await expect(operation).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
await expect.poll(() => processExists(descendantPid), { timeout: 2_000 }).toBe(false);
expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
```

The `finally` must kill a captured descendant if still alive, await `operation.catch(() => undefined)`, and only then allow test database/root cleanup. Add a companion addon-unavailable test proving no plugin fixture starts.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `npx vitest run packages/plugin-host/test/process-lifecycle.test.ts`

Expected: before Task 2 wiring, the Windows exited-parent case fails or times out; after wiring it becomes the regression proof for Job Object ownership.

- [ ] **Step 3: Remove the unsafe Windows taskkill fallback**

Make `terminateProcessTree` use direct `SIGKILL` only on non-Windows. On Windows, force-terminate the supervisor process if still live and await its `close`; the supervisor Job Object owns descendant cleanup. Remove the `taskkill.exe` implementation and the `exitCode` early-return condition that allowed orphan descendants to keep the runner pending.

- [ ] **Step 4: Make runner failures bounded and preserve primary errors**

Retain the current request-write and cancel-write timeout races. Ensure forced termination targets the supervisor and settles the runner before temporary-directory removal. A cleanup failure may add diagnostics but cannot replace `PLUGIN_TIMEOUT` or `PLUGIN_CANCELLED`. Keep `PLUGIN_SUPERVISOR_UNAVAILABLE` unwrapped so callers receive the actionable pre-launch error.

- [ ] **Step 5: Run focused lifecycle verification**

Run: `npx vitest run packages/plugin-host/test/artifact-validator.test.ts packages/plugin-host/test/process-lifecycle.test.ts packages/plugin-host/test/process-runner.test.ts packages/plugin-host/test/windows-supervisor.test.ts`

Expected: PASS; on Windows the direct-parent and exited-parent descendant tests execute rather than skip, and no unhandled rejection is printed.

- [ ] **Step 6: Update public documentation and milestone evidence**

Replace the README statement that Windows cleanup uses `taskkill.exe /T /F` with a description of the private Job Object supervisor, its complete-tree guarantee, and its non-sandbox boundary. State the Windows source-build prerequisites and that packaged Windows output includes the private addon. Add the same behavior to `CHANGELOG.md` under `Unreleased / Added`. In the M1 plan's Task 6 evidence, record the exited-parent regression and the supervisor replacement.

- [ ] **Step 7: Run the complete quality gate**

Run: `npm run verify`

Expected: PASS, including formatting, lint, type checking, Markdown linting, tests, coverage, SWC build, domain and repository policy checks, and `git diff --check`.

- [ ] **Step 8: Commit the lifecycle guarantee**

```powershell
git add packages/plugin-host README.md CHANGELOG.md docs/superpowers/plans/2026-07-18-plugin-platform.md
git commit -m "fix(plugin-host): guarantee Windows process tree cleanup"
```

## Coverage map

| Design requirement | Plan task |
| --- | --- |
| Kill-on-close Job Object before plugin spawn | Task 1, Task 2 |
| Transparent JSONL/stdin/stdout/stderr forwarding | Task 2 |
| No weak Windows fallback; stable unavailable diagnostic | Task 1, Task 2, Task 3 |
| Descendant survives direct parent exit then is terminated | Task 3 |
| No temporary lease or async teardown leak | Task 3 |
| Node-only public runtime and explicit source-build prerequisites | Task 1, Task 3 |
