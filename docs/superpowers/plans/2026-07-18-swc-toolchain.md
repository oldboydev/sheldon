# SWC Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile Sheldon with SWC and transform its Vitest TypeScript tests through SWC while preserving the current local CLI interface.

**Architecture:** `@swc/core` compiles every workspace `src/` tree to its adjacent `dist/` tree. The published workspace export paths point to those generated JavaScript files, so the compiled CLI can use the same package imports at runtime. `unplugin-swc` is registered in `vitest.config.ts`; its Vite adapter transforms TypeScript for Vitest, while explicit source aliases keep tests independent of generated artifacts.

**Tech Stack:** Node.js 24, TypeScript 6, SWC (`@swc/core`), Vitest 4, `unplugin-swc`, npm workspaces.

## Global Constraints

- Preserve `npm run build`, `npm test`, and `npm run verify` command interfaces.
- Keep Vitest as the only test runner and assertion framework.
- Use only local, free, open-source dependencies; do not add a cloud compiler or API.
- Emit ESM compatible with Node.js 24 and preserve existing `node:` imports.
- Update README.md and CHANGELOG.md in the implementation change set.
- Use Conventional Commits.

---

## File Structure

| File                      | Responsibility                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `vitest.config.ts`        | Registers SWC's Vite transform and resolves Sheldon packages to TypeScript source during tests. |
| `vitest.config.test.ts`   | Proves the Vitest configuration contains the SWC transform and source aliases.                  |
| `scripts/build.mjs`       | Compiles each workspace source directory into its matching `dist/` directory with SWC.          |
| `scripts/build.test.ts`   | Proves the build produces runnable CLI and workspace JavaScript artifacts.                      |
| `package.json`            | Replaces esbuild dependencies with SWC dependencies while retaining scripts.                    |
| `apps/cli/package.json`   | Points package exports at compiled JavaScript.                                                  |
| `packages/*/package.json` | Points workspace exports at compiled JavaScript.                                                |
| `package-lock.json`       | Locks the new free build and test-transform dependencies.                                       |
| `README.md`               | Documents the SWC/Vitest toolchain and build expectation.                                       |
| `CHANGELOG.md`            | Records the internal build-tool migration.                                                      |
| `eslint.config.mjs`       | Ignores generated `dist/` output for every workspace.                                           |
| `eslint.config.test.ts`   | Prevents generated workspace output from being linted as source.                                |

### Task 1: Configure SWC as the Vitest TypeScript transformer

**Files:**

- Create: `vitest.config.ts`
- Create: `vitest.config.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: the root `tsconfig.json` package aliases and Vitest's Vite configuration interface.
- Produces: a default Vitest config whose `plugins` include SWC, whose `oxc` transform is disabled, and whose aliases resolve `@sheldon/*` imports to source entry points.

- [x] **Step 1: Write the failing configuration test**

```ts
import { describe, expect, it } from 'vitest';

import config from './vitest.config.js';

describe('Vitest configuration', () => {
  it('uses SWC and resolves workspace packages to source', () => {
    expect(config.plugins?.map((plugin) => plugin.name)).toContain('swc');
    expect(config.oxc).toBe(false);
    expect(config.resolve?.alias).toMatchObject({
      '@sheldon/core': expect.stringMatching(/packages[\\/]core[\\/]src[\\/]index\.ts$/),
      '@sheldon/vault': expect.stringMatching(/packages[\\/]vault[\\/]src[\\/]index\.ts$/),
      '@sheldon/persistence': expect.stringMatching(
        /packages[\\/]persistence[\\/]src[\\/]index\.ts$/,
      ),
    });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- vitest.config.test.ts`

Expected: FAIL because `vitest.config.ts` does not exist.

- [x] **Step 3: Install the SWC compiler and Vite adapter**

Run: `npm install --save-dev @swc/core unplugin-swc`

Run: `npm uninstall --save-dev esbuild`

Expected: root `package.json` and `package-lock.json` contain `@swc/core` and `unplugin-swc`, and no root `esbuild` development dependency.

- [x] **Step 4: Create the minimal shared Vitest configuration**

```ts
import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  oxc: false,
  plugins: [swc.vite()],
  resolve: {
    alias: {
      '@sheldon/core': sourcePath('./packages/core/src/index.ts'),
      '@sheldon/vault': sourcePath('./packages/vault/src/index.ts'),
      '@sheldon/persistence': sourcePath('./packages/persistence/src/index.ts'),
    },
  },
});
```

- [x] **Step 5: Run configuration and existing test suites**

Run: `npm test -- vitest.config.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all existing tests plus the new configuration test PASS.

- [x] **Step 6: Commit the test-transform configuration**

```bash
git add package.json package-lock.json vitest.config.ts vitest.config.test.ts
git commit -m "build: transform tests with SWC"
```

### Task 2: Compile workspace source trees with SWC

**Files:**

- Create: `scripts/build.test.ts`
- Modify: `scripts/build.mjs`
- Modify: `apps/cli/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/vault/package.json`
- Modify: `packages/persistence/package.json`

**Interfaces:**

- Consumes: source directories `packages/*/src` and `apps/cli/src`.
- Produces: `packages/*/dist/**/*.js`, `apps/cli/dist/**/*.js`, and package exports that resolve `@sheldon/*` to `dist/index.js` at runtime.

- [x] **Step 1: Write the failing build contract test**

```ts
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('SWC build', () => {
  it('emits JavaScript for every workspace and a runnable CLI', async () => {
    const build = await execFileAsync(process.execPath, ['scripts/build.mjs']);

    expect(build.stderr).toBe('');
    await expect(access('packages/core/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/vault/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/persistence/dist/index.js')).resolves.toBeUndefined();
    await expect(access('apps/cli/dist/sheldon.js')).resolves.toBeUndefined();

    const corePackage = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
    expect(corePackage.exports['.']).toBe('./dist/index.js');

    const cli = await execFileAsync(process.execPath, ['apps/cli/dist/sheldon.js', '--help']);
    expect(cli.stdout).toContain('Local-first personal knowledge vault.');
  });
});
```

- [x] **Step 2: Run the build contract test to verify it fails**

Run: `npm test -- scripts/build.test.ts`

Expected: FAIL because the existing esbuild build does not emit `packages/*/dist/index.js` and the workspace export still references `src/index.ts`.

- [x] **Step 3: Replace the build script with a minimal SWC tree compiler**

```js
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { transformFile } from '@swc/core';

const targets = [
  ['packages/core/src', 'packages/core/dist'],
  ['packages/vault/src', 'packages/vault/dist'],
  ['packages/persistence/src', 'packages/persistence/dist'],
  ['apps/cli/src', 'apps/cli/dist'],
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

async function compile(sourceDirectory, outputDirectory) {
  await rm(outputDirectory, { recursive: true, force: true });
  for (const file of await sourceFiles(sourceDirectory)) {
    const output = join(outputDirectory, relative(sourceDirectory, file)).replace(/\.ts$/, '.js');
    await mkdir(dirname(output), { recursive: true });
    const { code } = await transformFile(file, {
      filename: file,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2023' },
      module: { type: 'es6' },
      sourceMaps: false,
    });
    await writeFile(output, code, 'utf8');
  }
}

await Promise.all(targets.map(([source, output]) => compile(source, output)));
```

- [x] **Step 4: Point workspace exports at compiled JavaScript**

Set each internal package's export to `./dist/index.js`; set the CLI package export to `./dist/main.js`; keep its `bin.sheldon` as `./dist/sheldon.js`.

```json
{
  "exports": {
    ".": "./dist/index.js"
  }
}
```

```json
{
  "exports": {
    ".": "./dist/main.js"
  },
  "bin": {
    "sheldon": "./dist/sheldon.js"
  }
}
```

- [x] **Step 5: Verify the build contract and executable CLI**

Run: `npm test -- scripts/build.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: exit code 0 and generated `dist/` trees for all workspaces.

Run: `node apps/cli/dist/sheldon.js --help`

Expected: exit code 0 and the `init`, `doctor`, `topic`, and `project` commands listed.

- [x] **Step 6: Commit the SWC production build**

```bash
git add scripts/build.mjs scripts/build.test.ts apps/cli/package.json packages/core/package.json packages/vault/package.json packages/persistence/package.json
git commit -m "build: compile workspaces with SWC"
```

### Task 3: Document and verify the complete toolchain

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `eslint.config.mjs`
- Create: `eslint.config.test.ts`

**Interfaces:**

- Consumes: the stable `build`, `test`, and `verify` commands.
- Produces: developer documentation that accurately states SWC's role in production and test compilation.

- [x] **Step 1: Add documentation expectations as a failing repository-policy check**

Extend `scripts/change-policy.test.ts` with a test that treats `vitest.config.ts` and `scripts/build.mjs` as implementation changes requiring `README.md` and `CHANGELOG.md` in the same change set.

```ts
it('requires documentation when the toolchain changes', () => {
  expect(evaluateChangePolicy(['vitest.config.ts'])).toEqual([
    'Implementation changes require README.md in the same change set.',
    'Implementation changes require CHANGELOG.md in the same change set.',
  ]);
});
```

- [x] **Step 2: Run the policy test to verify it fails**

Run: `npm test -- scripts/change-policy.test.ts`

Expected: FAIL because toolchain configuration is not yet classified as an implementation change.

- [ ] **Step 3: Extend the policy and update developer documentation**

Update `scripts/change-policy.mjs` so `vitest.config.ts` is in the implementation-change set. Add a README tooling note stating that `npm run build` compiles workspace source with SWC and `npm test` runs Vitest through `unplugin-swc`. Add a `Changed` entry to CHANGELOG describing replacement of esbuild with SWC. Add a test and a broad `**/dist/**` ESLint ignore so generated package output is never linted as source.

```js
const implementationPatterns = [
  /^(apps|packages|scripts)\//,
  /^(vitest\.config\.ts|package(-lock)?\.json|tsconfig\.json|eslint\.config\.mjs|prettier\.config\.mjs)$/,
];
```

- [x] **Step 4: Run the focused policy test**

Run: `npm test -- scripts/change-policy.test.ts`

Expected: PASS.

- [x] **Step 5: Run the full repository verification**

Run: `npm run verify`

Expected: formatting, ESLint, type checking, Markdown linting, all Vitest tests, SWC build, domain checks, repository policy, and `git diff --check` PASS.

- [x] **Step 6: Commit the documentation and verification policy**

```bash
git add README.md CHANGELOG.md scripts/change-policy.mjs scripts/change-policy.test.ts
git commit -m "docs: document SWC toolchain"
```

## Self-review

- Spec coverage: Task 1 keeps Vitest and routes TypeScript transforms through SWC; Task 2 emits Node 24 ESM artifacts, preserves package imports, and avoids cloud services; Task 3 records the change and runs the existing complete quality gate.
- Placeholder scan: no deferred or ambiguous implementation steps remain; all code samples use Node.js APIs supported by the project's Node 24 runtime.
- Type consistency: aliases map to each package's `src/index.ts`; production exports map to the matching `dist/index.js`, while the CLI exposes `dist/main.js` and its existing `dist/sheldon.js` binary.
