# NPM Public Install Go-Live Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Do **not** run `npm publish` from a developer machine or a pull request. The only local simulation is `npm pack` + the smoke runner. Tag `v0.2.0` is the publication trigger.

**Goal:** `npm install --global @oldboydev/sheldon` on Node 24 installs the current `main` CLI for win32-x64, linux-x64, darwin-x64, and darwin-arm64.

**Architecture:** The 2026-08-06 builder, smokes, and `publish-npm.yml` already exist. This plan does not rebuild them. It closes the go-live gap: npm currently serves a Windows-only 0.1.1 blob that is not the five-package model; OIDC publish jobs are missing `registry-url`; trusted publishers and the first `v*` tag have never been used.

**Tech Stack:** Node.js 24.13, npm 11, GitHub Actions OIDC trusted publishing, existing `scripts/release/build-npm-packages.mjs` and `smoke-npm-package.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-06-npm-publication-and-installation-design.md`  
**PRD:** `docs/prds/013-npm-publication-and-installation.md`  
**Prior plan (implemented in repo):** `docs/superpowers/plans/2026-08-06-npm-publication-and-installation.md`

## Global Constraints

- Never make the repository root or existing `@sheldon/*` workspaces public packages.
- Never publish from a developer machine or a pull request; `npm pack` is the only local publication simulation.
- No platform fallback, runtime download, symlink, source/test/dev dependency or secret in a tarball.
- Use one immutable SemVer for all five packages; never attempt to overwrite an npm version. **`0.1.0` and `0.1.1` are spent.** This release is **`0.2.0`**.
- Do not unpublish `0.1.1`. After `0.2.0` is `latest`, deprecate `0.1.1` with a message pointing at the new install.
- Existing M10 gates stay green and independent of npm packaging.
- Five packages, same version: `@oldboydev/sheldon`, `@oldboydev/sheldon-win32-x64`, `@oldboydev/sheldon-linux-x64`, `@oldboydev/sheldon-darwin-x64`, `@oldboydev/sheldon-darwin-arm64`.
- Publish order: four runtimes with tag `candidate`, then metapackage with tag `candidate`, then `npm dist-tag add … latest`.
- `workflow_dispatch` must not publish (already true).

## Grounding (why this is not a rebuild)

Observed 2026-09-16:

| Fact | Evidence |
|---|---|
| Builder, inventories, SBOM, smokes, workflow exist | `scripts/release/build-npm-packages.mjs`, `smoke-npm-package.mjs`, `.github/workflows/publish-npm.yml`, tests under `scripts/release/test/` |
| Registry has `@oldboydev/sheldon@0.1.1` | `npm view`: `os: ["win32"]`, `cpu: ["x64"]`, 5784 files, ~113 MB, published 2026-08-12 |
| Runtime packages 404 | `npm view @oldboydev/sheldon-win32-x64` → E404 |
| No git tags | `git tag -l 'v*'` empty |
| README already shows `npm install --global @oldboydev/sheldon` | Over-claims the M11 model |
| Roadmap M11 | “em implementação” |
| Publish jobs have `id-token: write` but `setup-node` has no `registry-url` | `.github/workflows/publish-npm.yml` `publish-runtimes`, `publish-metapackage`, `promote-npm-packages` |

## File map

- Modify: `.github/workflows/publish-npm.yml` — `registry-url` on OIDC npm jobs.
- Modify: `scripts/release/test/npm-publish-workflow.test.ts` — assert `registry-url`.
- Modify: `README.md`, `CHANGELOG.md`, `docs/roadmap.md`, `docs/README.md`.
- Create: `docs/product/npm-release-runbook.md` — operator checklist (trusted publisher, tag, verify, deprecate).

---

### Task 1: Tell the truth in docs and lock 0.2.0

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: registry facts above.
- Produces: user-facing copy that 0.1.1 is a Windows-only prototype; public matrix install is the upcoming 0.2.0 five-package release.

- [ ] **Step 1: Rewrite the README install section** so it matches reality until 0.2.0 is `latest`. Keep the command. Add the matrix, Node 24, and that Linux/macOS/Windows ARM are not in 0.1.1.

Use this block in `README.md` under `## Instalação` (replace the current three-line install):

```markdown
O pacote público requer Node.js 24 LTS ou superior.

```powershell
npm install --global @oldboydev/sheldon
sheldon --help
```

A distribuição estável (`0.2.0` e posteriores) instala um metapacote que seleciona o runtime da
plataforma: Windows x64, Linux x64, macOS Intel e Apple Silicon. Combinações fora dessa matriz
falham com diagnóstico; não há fallback.

`@oldboydev/sheldon@0.1.1` no npm é um protótipo somente Windows x64. Não use essa versão em
Linux, macOS ou Windows ARM. Após `0.2.0` tornar-se `latest`, `npm update --global @oldboydev/sheldon`
passa a instalar o modelo de cinco pacotes.

Para atualizar:

```powershell
npm update --global @oldboydev/sheldon
```

Para remover:

```powershell
npm uninstall --global @oldboydev/sheldon
```
```

- [ ] **Step 2: Changelog and roadmap**

In `CHANGELOG.md`, keep Grok under `[Unreleased]`. Add a `[0.2.0] - Unreleased` section (or keep Unreleased and a note) that will receive the five-package publication when the tag ships. Do **not** pretend 0.2.0 is already published.

In `docs/roadmap.md` M11 status, replace “em implementação” with “código no repositório; go-live bloqueado por trusted publisher npm e primeira tag `v0.2.0`”.

Link this plan from `docs/README.md` next to the 2026-08-06 npm plan.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md docs/roadmap.md docs/README.md
git commit -m "docs(release): describe 0.1.1 as windows prototype ahead of 0.2.0"
```

---

### Task 2: Give OIDC publish a registry-url

**Files:**
- Modify: `.github/workflows/publish-npm.yml`
- Modify: `scripts/release/test/npm-publish-workflow.test.ts`

**Interfaces:**
- Consumes: existing publish jobs (`publish-runtimes`, `publish-metapackage`, `promote-npm-packages`).
- Produces: those three jobs’ `actions/setup-node` steps set `registry-url: https://registry.npmjs.org` so `npm publish` / `npm dist-tag add` can use trusted publishing. Still no `NPM_TOKEN`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/release/test/npm-publish-workflow.test.ts`:

```ts
it('configures npm registry-url on every OIDC publish and dist-tag job', async () => {
  const { workflow } = await readWorkflow();
  const jobs = workflow.jobs ?? {};
  for (const name of ['publish-runtimes', 'publish-metapackage', 'promote-npm-packages']) {
    const setup = (jobs[name]?.steps ?? []).filter((step) =>
      step.uses?.startsWith('actions/setup-node@'),
    );
    expect(setup, name).not.toHaveLength(0);
    for (const step of setup) {
      expect(step.with?.['registry-url'], name).toBe('https://registry.npmjs.org');
      expect(step.with?.['node-version']).toBe('24.13.0');
    }
  }
  const { source } = await readWorkflow();
  expect(source).not.toContain('NPM_TOKEN');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/release/test/npm-publish-workflow.test.ts`
Expected: FAIL on `registry-url` undefined.

- [ ] **Step 3: Patch the workflow**

On each `actions/setup-node` step inside `publish-runtimes`, `publish-metapackage`, and `promote-npm-packages` only:

```yaml
- uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
  with:
    node-version: 24.13.0
    registry-url: https://registry.npmjs.org
```

Do not add `registry-url` to quality/build jobs. Do not add `NPM_TOKEN`. Keep `permissions.id-token: write` on those three jobs.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run scripts/release/test/npm-publish-workflow.test.ts`
Expected: PASS, including the existing “no NPM_TOKEN” assertion.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish-npm.yml scripts/release/test/npm-publish-workflow.test.ts
git commit -m "ci(release): set npm registry-url on oidc publish jobs"
```

---

### Task 3: Operator runbook

**Files:**
- Create: `docs/product/npm-release-runbook.md`
- Modify: `docs/README.md` (link the runbook)

**Interfaces:**
- Consumes: spec trusted-publisher rules; package names; version `0.2.0`.
- Produces: a checklist a human can execute without reading the workflow YAML.

- [ ] **Step 1: Write the runbook** with these sections, verbatim values:

```markdown
# Runbook — publicação npm do Sheldon

Versão desta go-live: `0.2.0` (tag `v0.2.0`). Não reutilizar `0.1.0` / `0.1.1`.

## Pacotes

- `@oldboydev/sheldon` (metapacote)
- `@oldboydev/sheldon-win32-x64`
- `@oldboydev/sheldon-linux-x64`
- `@oldboydev/sheldon-darwin-x64`
- `@oldboydev/sheldon-darwin-arm64`

Workflow: `.github/workflows/publish-npm.yml`  
Repositório npm `repository`: `https://github.com/oldboydev/sheldon`

## 1. Trusted publisher (bloqueia go-live)

Na organização npm `oldboydev`, para **cada** um dos cinco nomes:

1. Package settings → Trusted Publisher
2. Repository: `oldboydev/sheldon`
3. Workflow filename: `publish-npm.yml` (exato)
4. Environment: leave empty unless the workflow later adds `environment:`

Pacotes de runtime que ainda 404 devem ser criados pelo primeiro `npm publish` via OIDC, ou
provisionados vazios na org antes da tag. Sem trusted publisher, o job de publish falha e
`latest` não muda.

## 2. Proteção de tag

Em GitHub: restringir quem pode criar tags `v*`. Não publicar de PR. `workflow_dispatch` só
constroi e fumaça; não chama `npm publish`.

## 3. Dry-run

Actions → Publish npm packages → Run workflow. Input version: `0.0.0-dry-run.0`.

Esperado: jobs `quality-and-m10`, `build-and-verify-runtimes`, `build-metapackage` verdes;
jobs `publish-*` e `promote-npm-packages` **não** rodam (`if: github.event_name == 'push'`).

## 4. Tag estável

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

Não force-push a tag. Se o workflow falhar no meio, **não** reutilize `0.2.0`. Abra `0.2.1`.

## 5. Verificar

```bash
npm view @oldboydev/sheldon version
npm view @oldboydev/sheldon dist-tags
npm view @oldboydev/sheldon-win32-x64 version
npm view @oldboydev/sheldon-linux-x64 version
npm view @oldboydev/sheldon-darwin-x64 version
npm view @oldboydev/sheldon-darwin-arm64 version
```

Esperado: todos `0.2.0`; `dist-tags.latest` = `0.2.0` no metapacote. `optionalDependencies` do
metapacote lista os quatro runtimes.

Instalação limpa (Windows x64, Node 24):

```powershell
npm uninstall --global @oldboydev/sheldon
npm install --global @oldboydev/sheldon
sheldon --help
sheldon init $env:TEMP\sheldon-install-smoke --yes
```

## 6. Depreciar o protótipo 0.1.1

Somente depois de `0.2.0` ser `latest`:

```bash
npm deprecate @oldboydev/sheldon@0.1.1 "Windows-only prototype. Install @oldboydev/sheldon@latest (0.2.0+)."
```

Não unpublish.

## Recuperação

Publicação parcial (runtimes no `candidate`, metapacote ausente): não promover `latest` à mão.
Corrigir o workflow, taguear `v0.2.1`. Dist-tag `candidate` pode ficar órfão.
```

- [ ] **Step 2: Commit**

```bash
git add docs/product/npm-release-runbook.md docs/README.md
git commit -m "docs(release): add npm go-live runbook for 0.2.0"
```

---

### Task 4: Local Windows smoke of the current builder

**Files:** none committed. Uses existing scripts.

**Interfaces:**
- Consumes: `scripts/release/build-npm-packages.mjs`, `scripts/release/smoke-npm-package.mjs`.
- Produces: evidence that a staged `win32-x64` tarball installs and runs `sheldon --help` / `sheldon init` from a clean prefix on this machine.

- [ ] **Step 1: Build and stage only Windows**

From repo root, after `npm ci` and `npm run build`:

```powershell
node scripts/release/build-npm-packages.mjs --target win32-x64 --version 0.2.0 --output $env:TEMP\sheldon-npm-stage
node scripts/release/smoke-npm-package.mjs --package $env:TEMP\sheldon-npm-stage\win32-x64 --platform win32-x64
```

Expected: smoke exits 0; it must **not** invoke `.\apps\cli` or `npm run sheldon`.

- [ ] **Step 2: Inspect the staged metapackage** (optional extra, same output dir after adding `--metapackage` in a second invocation if the first command did not write it)

```powershell
node scripts/release/build-npm-packages.mjs --metapackage --version 0.2.0 --output $env:TEMP\sheldon-npm-meta
Get-Content $env:TEMP\sheldon-npm-meta\metapackage\package.json
```

Expected: `name` `@oldboydev/sheldon`, `version` `0.2.0`, `optionalDependencies` contains the four `@oldboydev/sheldon-*` names, **no** `"os": ["win32"]` on the metapackage.

- [ ] **Step 3: Record the commands and exit codes in the PR description.** Do not commit `$TEMP` staging. Do not `npm publish`.

If smoke fails, stop. Do not tag.

---

### Task 5: Human — trusted publisher and dry-run (blocks go-live)

**Files:** none. Operator only.

**Interfaces:**
- Consumes: runbook §1–3.
- Produces: npm org `oldboydev` trusts `oldboydev/sheldon` + `publish-npm.yml` for all five package names; a green `workflow_dispatch` dry-run.

- [ ] **Step 1:** Configure trusted publisher for the five package names (runbook §1).
- [ ] **Step 2:** Restrict who can push tags `v*` (runbook §2).
- [ ] **Step 3:** Run `workflow_dispatch` with `0.0.0-dry-run.0`. Confirm publish jobs skipped.
- [ ] **Step 4:** If dry-run fails (missing Intel macOS runner, native addon, timeout), fix in a follow-up commit **before** tagging. Do not paper over with a platform fallback.

This task cannot be finished by an agent without npm org admin. Status stays BLOCKED until the human checks the four boxes.

---

### Task 6: Tag `v0.2.0`, verify install, deprecate 0.1.1

**Files:**
- Modify: `CHANGELOG.md` — move publication notes under `[0.2.0] - YYYY-MM-DD` when the tag is cut.
- Modify: `docs/roadmap.md` — M11 status “concluído” only after `npm view` shows `0.2.0` as `latest` on all five packages.

**Interfaces:**
- Consumes: green dry-run, trusted publishers, Tasks 1–4 merged to `main`.
- Produces: `npm install --global @oldboydev/sheldon` on this Windows x64 machine runs the 0.2.0 launcher, which resolves `@oldboydev/sheldon-win32-x64`.

- [ ] **Step 1:** On `main` at the merge commit that contains Tasks 1–3:

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

- [ ] **Step 2:** Wait for `Publish npm packages` to finish. If `publish-runtimes` fails for one platform, do not `dist-tag add latest` by hand.

- [ ] **Step 3: Verify**

```bash
npm view @oldboydev/sheldon@0.2.0 optionalDependencies
npm view @oldboydev/sheldon dist-tags
```

Expected: four runtime names in `optionalDependencies`; `latest` is `0.2.0`.

```powershell
npm uninstall --global @oldboydev/sheldon
npm install --global @oldboydev/sheldon
sheldon --help
```

Expected: help from 0.2.0 (Grok appears in `--agent` help). `npm ls -g @oldboydev/sheldon-win32-x64` shows 0.2.0.

- [ ] **Step 4:** `npm deprecate @oldboydev/sheldon@0.1.1 "Windows-only prototype. Install @oldboydev/sheldon@latest (0.2.0+)."`
- [ ] **Step 5:** Date `[0.2.0]` in CHANGELOG; set M11 to concluído; commit `docs(release): record 0.2.0 npm publication`.

---

## Spec coverage

| Spec / PRD item | Task |
|---|---|
| Five packages, same SemVer, no overwrite | Global + 6 (`0.2.0`) |
| Metapackage selects runtime; no fallback | Already in builder; Task 4 inspects manifest |
| Runtimes published before metapackage; `latest` last | Existing workflow; Task 6 watches it |
| OIDC, no `NPM_TOKEN` | Task 2 |
| Trusted publisher + protected tag | Task 5 (human) |
| Clean-prefix `--help` / `init` | Task 4 local; Task 6 after tag |
| Docs: install, update, remove, Node 24, matrix | Task 1 + 3 |
| 0.1.1 Windows blob vs designed model | Task 1 + deprecate in 6 |
| Homebrew/MSI/internal `@sheldon/*` public | Out of scope |

## Placeholders / decisions

- Version **`0.2.0`** is the default. Override to `1.0.0` only if you want to call this the first stable; the spec does not require 1.0.0.
- `macos-15-intel` is required by the existing workflow matrix. If GitHub retired it, that is a Task 5 dry-run failure, not a reason to drop darwin-x64.
- Creating the four runtime package names on npm is part of Task 5 (first OIDC publish or manual provision). Not guessed here beyond “trusted publisher must exist for each name”.
