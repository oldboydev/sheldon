# Coverage Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce local Vitest V8 coverage for all Sheldon TypeScript sources with the approved repository thresholds and reports.

**Architecture:** Keep coverage policy in the root `vitest.config.ts`, where all workspace tests already resolve source through SWC. Prove the declarative policy with the existing configuration test, expose it through root npm scripts, and make `verify` execute coverage before build and repository-policy checks.

**Tech Stack:** Node.js 24, npm workspaces, TypeScript, Vitest 4, `@vitest/coverage-v8`, SWC.

## Global Constraints

- Statements, functions, and lines must each remain at or above 80%.
- Branches must remain at or above 70%.
- Coverage must include `apps/**/src` and `packages/**/src`, including untested source files.
- Tests, declaration files, configuration files, `dist/`, dependencies, and generated coverage reports must be excluded.
- Local reports must use terminal text, JSON, and HTML under `coverage/`.
- `npm test` must remain the fast non-coverage command.
- `npm run verify` must execute coverage after the normal test suite and before build and repository-policy checks.
- Do not add SaaS uploads, badges, automatic threshold updates, or replace Vitest/SWC.
- Work directly on `master`; do not push.

---

### Task 1: Declarative Coverage Policy

**Files:**

- Modify: `vitest.config.test.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: the existing root Vitest configuration and npm script gate.
- Produces: `config.test.coverage` with provider `v8`, source include/exclude globs, reporters, report directory, and thresholds; npm scripts `coverage` and `verify`.

- [ ] **Step 1: Write the failing configuration test**

Extend `vitest.config.test.ts` with a test that imports the root config and expects:

```ts
expect(config.test?.coverage).toMatchObject({
  provider: 'v8',
  include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
  reporter: ['text', 'json', 'html'],
  reportsDirectory: './coverage',
  thresholds: {
    statements: 80,
    functions: 80,
    lines: 80,
    branches: 70,
  },
});
```

Also assert that the exclusion list contains patterns for tests, declaration files, configuration files, `dist/`, `node_modules/`, and `coverage/`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npx vitest run vitest.config.test.ts`

Expected: FAIL because `config.test.coverage` is absent.

- [ ] **Step 3: Install the V8 provider and add the minimal configuration**

Run: `npm install --save-dev @vitest/coverage-v8`

Add this policy under `test.coverage` in `vitest.config.ts`:

```ts
coverage: {
  provider: 'v8',
  include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
  exclude: [
    '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    '**/*.d.ts',
    '**/*config*.{js,mjs,cjs,ts,mts,cts}',
    '**/dist/**',
    '**/node_modules/**',
    'coverage/**',
  ],
  reporter: ['text', 'json', 'html'],
  reportsDirectory: './coverage',
  thresholds: {
    statements: 80,
    functions: 80,
    lines: 80,
    branches: 70,
  },
},
```

Add `"coverage": "vitest run --coverage --passWithNoTests"` and insert `npm run coverage` in `verify` immediately after `npm run test`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run vitest.config.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the coverage gate and close only reported test gaps**

Run: `npm run coverage`

Expected: PASS with statements/functions/lines at least 80% and branches at least 70%. If a threshold fails, add focused behavior tests for uncovered source paths, rerunning the focused test and coverage gate after each addition.

### Task 2: Developer Documentation

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: the `coverage` and updated `verify` scripts from Task 1.
- Produces: developer-facing instructions for reports, thresholds, source scope, and gate behavior.

- [ ] **Step 1: Document the coverage command and verify behavior**

In `README.md`, explain that `npm run coverage` writes text, JSON, and HTML reports under `coverage/`, covers workspace `src/` files, and enforces 80/80/80/70 thresholds. Add `npm run coverage` to the individual command list and state that `verify` runs both normal tests and coverage.

- [ ] **Step 2: Record the quality gate in the changelog**

Under `Unreleased / Added`, record the local Vitest V8 coverage gate, source scope, report formats, and approved thresholds.

- [ ] **Step 3: Format and validate documentation**

Run: `npx prettier --write README.md CHANGELOG.md vitest.config.ts vitest.config.test.ts package.json package-lock.json docs/superpowers/plans/2026-07-18-coverage-quality-gate.md`

Expected: files are formatted successfully.

### Task 3: Repository Verification and Commits

**Files:**

- Verify all changed files from Tasks 1 and 2.

**Interfaces:**

- Consumes: the complete coverage policy and documentation.
- Produces: a verified `master` history with Conventional Commits and no push.

- [ ] **Step 1: Run the complete repository gate**

Run: `npm run verify`

Expected: PASS, including the normal test run, coverage thresholds, build, domain checks, repository policy, and `git diff --check`.

- [ ] **Step 2: Review the final diff against the design**

Run: `git diff --check` and `git diff --stat`.

Expected: no whitespace errors and changes limited to policy, dependency lockfile, tests, README, changelog, and this plan.

- [ ] **Step 3: Commit the implementation**

Run:

```powershell
git add docs/superpowers/plans/2026-07-18-coverage-quality-gate.md
git commit -m "docs: plan coverage quality gate"
git add package.json package-lock.json vitest.config.ts vitest.config.test.ts README.md CHANGELOG.md
git commit -m "build: enforce coverage quality gate"
```

Expected: both commits succeed under Commitlint. Do not push.
