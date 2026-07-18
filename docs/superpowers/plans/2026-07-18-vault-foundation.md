# Vault Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the local TypeScript CLI and durable vault foundation defined by PRD 001.

**Architecture:** An npm-workspaces monorepo separates domain rules, atomic vault I/O, SQLite operational state, and the CLI adapter. Markdown/YAML files are durable truth; SQLite is expendable operational state. The CLI composes packages and never accesses the network.

**Tech Stack:** Node.js 24 LTS+, TypeScript 5, npm workspaces, Commander, `yaml`, built-in `node:sqlite`, Vitest, ESLint, Prettier, markdownlint-cli2, Commitlint and Husky.

## Global Constraints

- Support Windows paths with `node:path`; do not construct paths with `/`.
- Required behavior is local and open source: no model API, SaaS or network call.
- User knowledge is Markdown/YAML; SQLite is only an index and audit store.
- Write configuration and metadata with a same-directory temporary file and atomic rename.
- Do not overwrite a colliding topic or project.
- Preserve entity IDs on rename and preserve archived content.
- Update the closest README and `CHANGELOG.md` with public behavior.
- Use Conventional Commits and run `npm run verify` before each implementation commit.

---

## Execution status

- [x] Task 1 — Workspace and quality gates
- [x] Task 2 — Entity and slug domain
- [x] Task 3 — Vault layout and atomic lifecycle
- [x] Task 4 — SQLite operational state
- [ ] Task 5 — CLI, configuration and doctor
- [ ] Task 6 — Acceptance audit

## Proposed file structure

```text
apps/cli/
  src/main.ts                 Commander entry point and exit-code mapping
  src/commands/*.ts           Thin command adapters
  test/*.test.ts              CLI integration tests
packages/core/
  src/entity.ts               Entity contracts and lifecycle helpers
  src/slug.ts                 Unicode-safe slug generation
  test/*.test.ts
packages/vault/
  src/atomic-write.ts         Same-directory temp-write and rename
  src/layout.ts               Vault paths and structure validation
  src/vault-service.ts        Init, discovery and entity lifecycle
  test/*.test.ts
packages/persistence/
  src/operations-db.ts        SQLite schema and audit writes
  test/*.test.ts
scripts/
  verify-domain.mjs           Vault fixture/domain validation
```

## Task 1: Establish the workspace and quality gates

**Files:**

- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `prettier.config.mjs`
- Create: `.markdownlint-cli2.mjs`, `commitlint.config.cjs`, `.husky/commit-msg`
- Create: `.gitattributes`, `.gitignore`, `scripts/verify-domain.mjs`
- Create: `apps/cli/package.json`, `packages/core/package.json`, `packages/vault/package.json`, `packages/persistence/package.json`
- Modify: `README.md` and `CHANGELOG.md`

**Interfaces:**

- Root commands: `lint`, `format:check`, `typecheck`, `test`, `lint:md`, `lint:domain` and `verify`.
- Workspace imports: `@sheldon/core`, `@sheldon/vault`, `@sheldon/persistence` and `@sheldon/cli`.

- [ ] **Step 1: Write the failing domain-check smoke test**

Create `scripts/verify-domain.mjs`:

```js
import { existsSync } from 'node:fs';

if (!existsSync('test-fixtures/valid-vault/system/vault.yaml')) {
  throw new Error('Required vault fixture is missing.');
}
```

- [ ] **Step 2: Verify RED**

Run: `node scripts/verify-domain.mjs`

Expected: exit 1 with `Required vault fixture is missing.`

- [ ] **Step 3: Implement the workspace and domain check**

Create `test-fixtures/valid-vault/system/vault.yaml`:

```yaml
format: sheldon-vault/v1
version: 1
created_at: 2026-07-18T00:00:00.000Z
```

Replace the smoke check with a validator that reads every `test-fixtures/*/system/vault.yaml`, requires `format: sheldon-vault/v1`, and emits its failing path. Configure the root `package.json` exactly with these command contracts:

```json
{
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint:md": "markdownlint-cli2 '**/*.md' '#node_modules'",
    "lint:domain": "node scripts/verify-domain.mjs",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm run lint:md && npm run test && npm run lint:domain && git diff --check"
  }
}
```

Use `* text=auto eol=lf` in `.gitattributes`. Ignore `node_modules/`, `coverage/`, `*.db`, `*.db-shm` and `*.db-wal`. Configure the commit hook to run `npx --no -- commitlint --edit "$1"`.

- [ ] **Step 4: Verify GREEN and install tools**

Run: `node scripts/verify-domain.mjs`

Expected: exit 0.

Run: `npm install commander yaml`

Run: `npm install -D typescript vitest eslint @eslint/js typescript-eslint prettier eslint-config-prettier markdownlint-cli2 @commitlint/cli @commitlint/config-conventional husky @types/node globals`

Run: `npm run lint && npm run typecheck && npm run lint:md`

Expected: every command exits 0 and `package-lock.json` is generated.

- [ ] **Step 5: Document and commit**

Document installation, `npm run verify` and workspace layout in `README.md`. Add an Unreleased entry.

Run: `git add package.json package-lock.json tsconfig.json eslint.config.mjs prettier.config.mjs .markdownlint-cli2.mjs commitlint.config.cjs .husky/commit-msg .gitattributes .gitignore scripts test-fixtures README.md CHANGELOG.md apps packages`

Run: `git commit -m "build: scaffold TypeScript workspace"`

## Task 2: Define entities and slug behavior

**Files:**

- Create: `packages/core/src/entity.ts`, `packages/core/src/slug.ts`, `packages/core/src/index.ts`
- Create: `packages/core/test/slug.test.ts` and `packages/core/test/entity.test.ts`

**Interfaces:**

- Produces `EntityKind = 'topic' | 'project'`, `EntityStatus = 'active' | 'archived'` and `VaultEntityMetadata`.
- Produces `slugify(title: string): string` and `createEntityMetadata(input): VaultEntityMetadata`.
- `@sheldon/vault` depends on this package; it does not depend on the CLI or SQLite package.

- [ ] **Step 1: Write failing slug tests**

```ts
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slug.js';

describe('slugify', () => {
  it('normalizes accents while preserving the source title elsewhere', () => {
    expect(slugify('Arquitetura de Agentes: São Paulo')).toBe('arquitetura-de-agentes-sao-paulo');
  });

  it('rejects titles with no slug-safe characters', () => {
    expect(() => slugify('  !!!  ')).toThrow('cannot produce a slug');
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/core/test/slug.test.ts`

Expected: FAIL because `slugify` is missing.

- [ ] **Step 3: Implement minimum core behavior**

```ts
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) throw new Error('Title cannot produce a slug.');
  return slug;
}
```

Define metadata with immutable `id`, `title`, optional `description`, `slug`, `kind`, `status`, `created_at`, `updated_at` and optional `archived_at`. Use `crypto.randomUUID()` and ISO-8601 UTC timestamps.

- [ ] **Step 4: Complete entity tests and verify GREEN**

Test that changing a slug preserves `id` and `created_at`. Test archive sets `status: 'archived'` and a timestamp.

Run: `npm test -- --run packages/core/test && npm run typecheck`

Expected: all core tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

Run: `git add packages/core`

Run: `git commit -m "feat(core): add vault entity contracts"`

## Task 3: Implement vault layout, atomic writes and lifecycle

**Files:**

- Create: `packages/vault/src/atomic-write.ts`, `packages/vault/src/layout.ts`, `packages/vault/src/vault-service.ts`, `packages/vault/src/index.ts`
- Create: `packages/vault/test/atomic-write.test.ts` and `packages/vault/test/vault-service.test.ts`

**Interfaces:**

- Consumes core entity types and `slugify`.
- Produces `VaultService.init`, `discover`, `createEntity`, `listEntities`, `inspectEntity`, `renameEntity` and `archiveEntity`.
- Stores config at `<vault>/system/vault.yaml` and metadata at `<vault>/(topics|projects)/<slug>/metadata.yaml`.

- [ ] **Step 1: Write the failing atomic-write test**

```ts
it('keeps the previous file when rename preparation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-'));
  const target = join(directory, 'metadata.yaml');

  await atomicWriteFile(target, 'old');
  await expect(
    atomicWriteFile(target, 'new', {
      beforeRename: () => {
        throw new Error('stop');
      },
    }),
  ).rejects.toThrow('stop');

  await expect(readFile(target, 'utf8')).resolves.toBe('old');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/vault/test/atomic-write.test.ts`

Expected: FAIL because `atomicWriteFile` is missing.

- [ ] **Step 3: Implement atomic write and layout**

Implement `atomicWriteFile(target, content, hooks?)` with a unique same-directory temporary filename, `open(..., 'wx')`, UTF-8 write, close, optional `beforeRename`, then `rename(temp, target)`. On failure, remove only that known temporary file and rethrow; never delete the target.

`init` creates `topics/`, `projects/`, `bundles/`, `system/` and `system/vault.yaml`. `discover(path)` succeeds only when that YAML has `format: sheldon-vault/v1` and never scans a parent disk.

- [ ] **Step 4: Write lifecycle tests**

```ts
it('does not overwrite an entity whose normalized slug exists', async () => {
  const vault = await makeTemporaryVault();
  await vault.createEntity({ kind: 'topic', title: 'São Paulo' });

  await expect(vault.createEntity({ kind: 'topic', title: 'Sao Paulo' })).rejects.toThrow(
    'topics/sao-paulo already exists',
  );
});

it('renames an entity without changing its id', async () => {
  const vault = await makeTemporaryVault();
  const created = await vault.createEntity({ kind: 'project', title: 'Old Name' });
  const renamed = await vault.renameEntity('project', 'old-name', 'New Name');

  expect(renamed.id).toBe(created.id);
  expect(renamed.slug).toBe('new-name');
});
```

- [ ] **Step 5: Implement lifecycle and verify GREEN**

`createEntity` uses exclusive directory creation, then writes `metadata.yaml` atomically. `renameEntity` validates destination collision, moves the entity directory, updates metadata atomically and preserves the ID. `archiveEntity` changes metadata status only. `listEntities` and `inspectEntity` do not write.

Run: `npm test -- --run packages/vault/test && npm run typecheck`

Expected: all vault tests and typecheck pass.

- [ ] **Step 6: Commit**

Run: `git add packages/vault`

Run: `git commit -m "feat(vault): add atomic entity lifecycle"`

## Task 4: Add SQLite operational state

**Files:**

- Create: `packages/persistence/src/operations-db.ts` and `packages/persistence/src/index.ts`
- Create: `packages/persistence/test/operations-db.test.ts`
- Modify: `packages/vault/src/vault-service.ts` and its tests

**Interfaces:**

- Produces `OperationsDatabase.open(path)`, `recordOperation`, `listOperations` and `getRebuildStatus`.
- Vault lifecycle writes an audit record after durable file changes complete.

- [ ] **Step 1: Write the failing operational-state test**

```ts
it('records an operation outside knowledge files', () => {
  const db = OperationsDatabase.open(':memory:');

  db.recordOperation({
    action: 'entity.created',
    entityId: 'entity-1',
    at: '2026-07-18T00:00:00.000Z',
  });

  expect(db.listOperations()).toEqual([
    expect.objectContaining({ action: 'entity.created', entityId: 'entity-1' }),
  ]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run packages/persistence/test/operations-db.test.ts`

Expected: FAIL because `OperationsDatabase` is missing.

- [ ] **Step 3: Implement and test recovery**

Use the built-in `DatabaseSync` from `node:sqlite` with parameterized statements. Create an `operations` table with `id`, `action`, nullable `entity_id`, `at` and `details_json`. `getRebuildStatus()` states that operational SQLite is removable and reconstructed from vault files.

Add an integration test: create a topic, assert `entity.created`, delete `system/operations.db`, reopen and read the topic metadata successfully.

Run: `npm test -- --run packages/persistence/test packages/vault/test`

Expected: all selected tests pass.

- [ ] **Step 4: Commit**

Run: `git add packages/persistence packages/vault`

Run: `git commit -m "feat(persistence): record vault operations locally"`

## Task 5: Expose CLI, configuration and doctor

**Files:**

- Create: `apps/cli/src/main.ts`, `apps/cli/src/config.ts`
- Create: `apps/cli/src/commands/init.ts`, `apps/cli/src/commands/entities.ts`, `apps/cli/src/commands/doctor.ts`
- Create: `apps/cli/test/cli.test.ts`
- Modify: `README.md` and `CHANGELOG.md`

**Interfaces:**

- Provides `sheldon init [path]`; `topic create|list|show|rename|archive`; `project create|list|show|rename|archive`; and `sheldon doctor`.
- Uses only an explicit path, `--vault` or a configured vault path; it never performs broad disk discovery.
- Stores app configuration in `%APPDATA%\\Sheldon\\config.yaml` on Windows (with a documented local fallback when `APPDATA` is absent); it does not put machine-specific configuration inside the vault.

- [ ] **Step 1: Write failing CLI integration test**

```ts
it('initializes an explicit vault and recognizes it in a later invocation', async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), 'sheldon-cli-'));

  await expect(runCli(['init', vaultPath])).resolves.toMatchObject({ exitCode: 0 });
  await expect(runCli(['doctor', '--vault', vaultPath])).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining('Vault: healthy'),
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/cli/test/cli.test.ts`

Expected: FAIL because `runCli` is missing.

- [ ] **Step 3: Implement commands and errors**

Use Commander and an injected `CliDependencies` object so `runCli(args, dependencies)` is testable without a shell. Render every domain error as:

```text
Error: <cause>
Target: <path>
Recovery: <action>
```

`init` is idempotent for an existing valid vault and fails cleanly for a conflicting non-vault directory. Without `[path]`, it proposes `%USERPROFILE%\\Documents\\Sheldon`, prints the full target, and requires an interactive confirmation or `--yes`. `doctor` checks Node.js, root layout, SQLite existence/rebuild status and `codex`/`claude` availability. Missing agent CLIs are warnings, not failures in PRD 001.

- [ ] **Step 4: Add command acceptance tests and verify GREEN**

Cover accented original titles, duplicate slugs without overwrite, rename identity, archive retention, read-only list behavior, and no-path initialization requiring confirmation before it writes.

Run: `npm test -- --run apps/cli/test`

Run: `npm run verify`

Expected: CLI tests pass and every quality gate exits 0.

- [ ] **Step 5: Document and commit**

Add a PowerShell quick start, all command examples, vault layout, recovery guarantees and doctor interpretation to `README.md`. Add the user-visible commands to `CHANGELOG.md`.

Run: `git add apps/cli README.md CHANGELOG.md`

Run: `git commit -m "feat(cli): add local vault commands"`

## Task 6: Perform the PRD acceptance audit

**Files:**

- Create: `apps/cli/test/acceptance.test.ts`
- Modify: `README.md`, `CHANGELOG.md`, `docs/roadmap.md` and `docs/prds/001-foundation-and-vault.md`

**Interfaces:**

- One automated scenario verifies each acceptance criterion in PRD 001.

- [ ] **Step 1: Write the failing atomic-failure acceptance test**

```ts
it('keeps old metadata after a simulated rename failure', async () => {
  const vault = await makeTemporaryVault({ failRename: true });
  await vault.createEntity({ kind: 'topic', title: 'Atomicity' });

  await expect(vault.renameEntity('topic', 'atomicity', 'Renamed')).rejects.toThrow();

  expect(await vault.inspectEntity('topic', 'atomicity')).toMatchObject({
    title: 'Atomicity',
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run apps/cli/test/acceptance.test.ts`

Expected: FAIL because the injected filesystem adapter does not exist.

- [ ] **Step 3: Implement testable filesystem injection and complete acceptance coverage**

Inject `VaultFileSystem` into `VaultService` with a default Node implementation. The test wrapper throws from `rename` after the temporary file closes. Add cases for config-only discovery, SQLite deletion recovery, duplicate slugs and no network use. Do not expose a test-only method in the public CLI.

- [ ] **Step 4: Run release verification**

Run: `npm run verify`

Run: `git status --short`

Expected: `verify` exits 0 and status contains only intended documentation changes before staging.

- [ ] **Step 5: Update evidence and commit**

Mark M0 implemented only after the release gate passes. Record acceptance evidence in the PRD, update README and changelog.

Run: `git add README.md CHANGELOG.md docs/roadmap.md docs/prds/001-foundation-and-vault.md apps/cli/test/acceptance.test.ts packages/vault`

Run: `git commit -m "test: verify vault foundation acceptance"`

## Coverage audit

| PRD requirement                            | Planned task |
| ------------------------------------------ | ------------ |
| Init, explicit/config discovery and layout | 3 and 5      |
| Metadata, slugs, rename and archive        | 2 and 3      |
| SQLite state and reconstruction            | 4 and 5      |
| Atomic failure safety                      | 3 and 6      |
| Local doctor diagnostics                   | 5            |
| Lint, test and commit standards            | 1 and 6      |
| README and changelog maintenance           | 1, 5 and 6   |

## Plan self-review

- Every PRD 001 functional and acceptance requirement maps to a task.
- The plan is local-only and keeps durable knowledge outside SQLite.
- Every behavior begins with an explicit failing test and a command to observe RED.
- Failure injection uses dependency injection and never becomes public CLI behavior.
