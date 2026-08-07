# NPM Publication and Installation Plan

> For agentic workers: use subagent-driven development task-by-task with an implementer and a
> read-only review gate. Do not publish to npm during development or PR validation.

**Goal:** Install the supported Sheldon CLI through `npm install -g @oldboydev/sheldon`.

**Architecture:** A small metapackage selects one npm platform runtime; each runtime is produced in
isolated staging from the compiled monorepo closure and tested as an installed tarball. A protected
tag publishes runtimes before the metapackage through npm OIDC trusted publishing.

**Tech Stack:** Node.js 24, npm workspaces/pack, TypeScript, GitHub Actions, npm trusted publishing,
Vitest, native Windows/macOS/Linux runners.

## Global constraints

- Never make the repository root or existing `@sheldon/*` workspaces public packages.
- Never publish from a developer machine or a pull request; `npm pack` is the only local publication
  simulation.
- No platform fallback, runtime download, symlink, source/test/dev dependency or secret in a tarball.
- Use one immutable SemVer for all five packages; never attempt to overwrite an npm version.
- Existing M10 gates and official-plugin release stay green and remain independent of npm packaging.

### Task 1: Package model and negative contracts

Files: create package metadata templates, package-model module and focused tests.

- [ ] Write failing tests for target selection, unsupported targets, manifest `os`/`cpu`, version
      consistency, allowed package names and stable diagnostics.
- [ ] Implement typed target inventory for win32-x64, linux-x64, darwin-x64 and darwin-arm64 plus a
      metapackage manifest generator with optional dependencies.
- [ ] Run focused tests, typecheck and lint; commit `feat(release): define npm platform packages`.

### Task 2: Isolated runtime staging

Files: create npm-package builder, allowlist/inventory module, tests; modify build/release scripts.

- [ ] Write failing tests for closure collection, no symlinks, containment, forbidden files,
      deterministic inventory, resources and Windows addon inclusion.
- [ ] Implement staging outside workspaces, copy only compiled production closure, rewrite internal
      manifests for bundled use and emit file/hash/SBOM inventories.
- [ ] Run builder unit tests and `npm pack --dry-run`; commit
      `feat(release): build isolated npm runtime packages`.

### Task 3: Installed-tarball acceptance

Files: create pack/install smoke runner and acceptance tests; modify CI helpers as necessary.

- [ ] Write failing tests for clean global prefix installation, executable resolution, `--help`,
      `init`, no workspace dependency and unsupported target diagnostics.
- [ ] Implement native smoke runner that packs, installs the tarball in a temporary prefix and vault,
      then exercises the installed binary and platform supervisor fixture.
- [ ] Run on Windows, Docker Linux and native macOS runners; commit
      `test(release): verify installed npm tarballs`.

### Task 4: Release workflow and trusted publishing

Files: create `.github/workflows/publish-npm.yml`; modify release documentation/scripts/tests.

- [ ] Write static workflow tests for tag-only trigger, least permissions, `id-token: write`, Node
      24, runtime-before-metapackage order, exact repository URL and prohibited `NPM_TOKEN`.
- [ ] Implement build matrix, artifact handoff, package verification, candidate dist-tags and ordered
      npm OIDC publish. Attach package hashes/SBOM to the GitHub Release.
- [ ] Configure the npm trusted publisher manually after the workflow filename is merged; run only a
      non-publishing `workflow_dispatch` dry-run until configuration is confirmed.
- [ ] Commit `ci(release): publish npm packages through oidc`.

### Task 5: User documentation and release rehearsal

Files: modify README, CHANGELOG, docs/roadmap; add release runbook.

- [ ] Document install/update/removal commands, Node 24 prerequisite, supported matrix, `latest` and
      `next`, diagnostics and recovery from partial publication.
- [ ] Rehearse the full workflow with tarballs only across all supported native targets; independently
      review package contents, platform selection, addon handling and trusted-publisher boundaries.
- [ ] Run `npm run verify`, release-specific tests, all native smokes and `git diff --check`; commit
      `docs(release): document npm installation`.
