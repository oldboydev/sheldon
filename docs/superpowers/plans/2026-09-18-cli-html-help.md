# CLI HTML Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship offline HTML help with the installed CLI — browsable pages, copy-paste examples, and flow guides — openable via `sheldon help --html`, without replacing Commander `--help`.

**Architecture:** Curated Markdown lives under `apps/cli/help/`. A small build-time converter writes static HTML into `apps/cli/dist/help/` (no new runtime dependency). A shared `manifest.json` lists every top-level command group and topic page so tests fail if Commander gains a group without a help page. The CLI resolves the help root next to `sheldon.js`, prints the path with `--path`, or opens the default browser with `--html`. Content ships inside `@sheldon/cli` and therefore inside the npm runtime closure automatically.

**Tech Stack:** TypeScript, Commander 15, Node 24, Vitest, existing `scripts/build.mjs` (SWC). Constrained Markdown→HTML converter in `scripts/build-cli-help.mjs` (headings, paragraphs, lists, fenced code, inline code, links, bold) — no new npm dependency.

**Spec:** GitHub issue [#26](https://github.com/oldboydev/sheldon/issues/26) — _Add detailed HTML help with examples for the CLI_.

## Global Constraints

- Keep Commander `--help` / `sheldon help <command>` text help unchanged in behavior for the no-flag case.
- Offline only: help must not fetch the network.
- No second drift-prone catalog of command _names_: `manifest.json` is the inventory; Commander descriptions stay short; HTML pages expand with examples.
- Windows PowerShell and Unix examples where flags/paths differ; otherwise one block labeled for both.
- Do not build a tutorial web app; this is static HTML opened in the system browser.
- Do not invent a vault-list feature; document default vault + `--vault` clearly.
- Conventional Commits; update `CHANGELOG.md` Unreleased; `npm run verify` before claiming done.
- Help assets must end up under `apps/cli/dist/help/` so the npm runtime package includes them.

## File map

- Create: `apps/cli/help/manifest.json` — page inventory (id, title, path, `commands` covered).
- Create: `apps/cli/help/pages/*.md` — curated content.
- Create: `apps/cli/help/styles.css` — shared stylesheet copied into `dist/help/`.
- Create: `scripts/build-cli-help.mjs` — MD → HTML + index.
- Create: `apps/cli/src/help.ts` — resolve help root, open browser, print path.
- Create: `apps/cli/test/help.test.ts` — inventory coverage + CLI flags.
- Modify: `apps/cli/src/main.ts` — custom `help` command with `--html` / `--path`.
- Modify: `scripts/build.mjs` — run help builder after CLI compile.
- Modify: `README.md`, `CHANGELOG.md`, `docs/README.md`.

### Top-level command inventory (must all appear in the manifest)

`init`, `doctor`, `migrate-state`, `web`, `topic`, `project`, `ingest`, `compile`, `compile-retry`, `review`, `bundle`, `search`, `query`, `answer`, `agent`, `mcp`, `plugin`, `image`.

---

### Task 1: Help inventory, converter, and first pages

**Files:**

- Create: `apps/cli/help/manifest.json`
- Create: `apps/cli/help/styles.css`
- Create: `apps/cli/help/pages/index.md`
- Create: `apps/cli/help/pages/init.md`
- Create: `apps/cli/help/pages/flow-first-vault.md`
- Create: `scripts/build-cli-help.mjs`
- Create: `scripts/release/test/build-cli-help.test.ts` (or `apps/cli/test/build-cli-help.test.ts` — prefer `apps/cli/test/help-build.test.ts`)
- Modify: `scripts/build.mjs`

**Interfaces:**

- Consumes: Markdown pages + `manifest.json`.
- Produces: `apps/cli/dist/help/index.html`, `apps/cli/dist/help/pages/*.html`, `apps/cli/dist/help/styles.css`, `apps/cli/dist/help/manifest.json`.
- Produces: `buildCliHelp({ sourceDir, outputDir })` export for tests.

- [ ] **Step 1: Write the failing build test**

```ts
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCliHelp } from '../../../scripts/build-cli-help.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('buildCliHelp', () => {
  it('renders markdown pages listed in the manifest to html', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-help-'));
    roots.push(root);
    const sourceDir = join(root, 'help');
    const outputDir = join(root, 'out');
    await mkdir(join(sourceDir, 'pages'), { recursive: true });
    await writeFile(
      join(sourceDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        pages: [{ id: 'index', title: 'Sheldon help', file: 'pages/index.md', commands: [] }],
      }),
      'utf8',
    );
    await writeFile(
      join(sourceDir, 'pages', 'index.md'),
      '# Sheldon help\n\nHello `init`.\n',
      'utf8',
    );
    await writeFile(join(sourceDir, 'styles.css'), 'body{font-family:sans-serif}', 'utf8');

    await buildCliHelp({ sourceDir, outputDir });

    const html = await readFile(join(outputDir, 'index.html'), 'utf8');
    expect(html).toContain('<h1>Sheldon help</h1>');
    expect(html).toContain('<code>init</code>');
    expect(html).toContain('styles.css');
    await expect(readFile(join(outputDir, 'styles.css'), 'utf8')).resolves.toContain('sans-serif');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/help-build.test.ts`  
Expected: FAIL resolving `build-cli-help.mjs`.

- [ ] **Step 3: Implement converter + first content**

`manifest.json` shape:

```json
{
  "schemaVersion": 1,
  "pages": [
    { "id": "index", "title": "Sheldon help", "file": "pages/index.md", "commands": [] },
    { "id": "init", "title": "init", "file": "pages/init.md", "commands": ["init"] },
    {
      "id": "flow-first-vault",
      "title": "First vault",
      "file": "pages/flow-first-vault.md",
      "commands": ["init"]
    }
  ]
}
```

For this task only these three pages are required; later tasks append to the same manifest. `index.md` links to flows and notes that vaults are not listed — use the default from `init` or `--vault`.

`build-cli-help.mjs` must:

1. Read and validate `manifest.json` (`schemaVersion === 1`, unique `id`, every `file` exists).
2. Convert each page with a constrained renderer supporting `#`–`###`, paragraphs, `-` lists, fenced ` ``` ` blocks, `` `code` ``, `[text](href)`, `**bold**`.
3. Wrap in an HTML shell with `<link rel="stylesheet" href="styles.css">` (use `../styles.css` from `pages/`).
4. Write `index.html` at the help root for the `index` page; other pages under `pages/<id>.html`.
5. Copy `styles.css` and `manifest.json` into the output.

Wire `scripts/build.mjs` after the skill copy:

```js
await execFileAsync(process.execPath, [join('scripts', 'build-cli-help.mjs')]);
```

Default CLI for the script: source `apps/cli/help`, output `apps/cli/dist/help`.

- [ ] **Step 4: Run the tests and a local build**

Run: `npx vitest run apps/cli/test/help-build.test.ts`  
Run: `node scripts/build-cli-help.mjs`  
Expected: PASS; `apps/cli/dist/help/index.html` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/help scripts/build-cli-help.mjs scripts/build.mjs apps/cli/test/help-build.test.ts
git commit -m "feat(cli): build offline html help from curated markdown"
```

---

### Task 2: CLI `help --html` / `--path`

**Files:**

- Create: `apps/cli/src/help.ts`
- Create: `apps/cli/test/help.test.ts`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**

- Consumes: `apps/cli/dist/help/` next to `sheldon.js` (via `import.meta.url`).
- Produces:
  - `resolveHelpRoot(): string`
  - `resolveHelpPage(topic: string | undefined): string` — absolute HTML path
  - `openHelpPage(path: string, open?: (target: string) => Promise<void>): Promise<void>`
  - CLI: `sheldon help --path`, `sheldon help --html [topic]`

- [ ] **Step 1: Write the failing CLI tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveHelpPage, openHelpPage } from '../src/help.js';
import { runCli } from '../src/main.js';
// use existing test helpers from apps/cli/test if available (runCli fixture)

describe('html help', () => {
  it('resolves the index and a topic page under the help root', async () => {
    // point HELP root via dependency injection or temp override used by tests
    const root = await createTempHelpRoot();
    expect(resolveHelpPage(undefined, root)).toBe(join(root, 'index.html'));
    expect(resolveHelpPage('init', root)).toBe(join(root, 'pages', 'init.html'));
  });

  it('opens the html page through the injected opener', async () => {
    const open = vi.fn(async () => undefined);
    await openHelpPage('/tmp/help/index.html', open);
    expect(open).toHaveBeenCalledWith('/tmp/help/index.html');
  });

  it('prints the help root for --path and opens html for --html', async () => {
    const open = vi.fn(async () => undefined);
    const pathResult = await runCli(['help', '--path'], {/* inject help root + open */});
    expect(pathResult.exitCode).toBe(0);
    expect(pathResult.stdout).toContain('help');

    const htmlResult = await runCli(['help', '--html', 'init'], { openHelp: open });
    expect(htmlResult.exitCode).toBe(0);
    expect(open).toHaveBeenCalled();
  });
});
```

Adapt to the repo’s real `runCli` / dependency injection pattern in `apps/cli/test/main.test.ts` and `cli.test.ts`. Prefer extending `CliDependencies` with `openHelp?: (path: string) => Promise<void>` and `helpRoot?: string` rather than mocking the whole filesystem.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/help.test.ts`  
Expected: FAIL (module / flags missing).

- [ ] **Step 3: Implement help resolution and Commander wiring**

`help.ts`:

```ts
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function defaultHelpRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'help');
}

export function resolveHelpPage(topic: string | undefined, root: string): string {
  if (!topic || topic === 'index') return join(root, 'index.html');
  return join(root, 'pages', `${topic}.html`);
}

export async function assertHelpPageExists(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`HELP_PAGE_MISSING: Offline help page not found at ${path}.`);
  }
}

export async function openHelpPage(
  path: string,
  open: (target: string) => Promise<void> = openWithSystemBrowser,
): Promise<void> {
  await assertHelpPageExists(path);
  await open(path);
}

async function openWithSystemBrowser(path: string): Promise<void> {
  const fileUrl = pathToFileURL(path).href;
  if (process.platform === 'win32') {
    await spawnDetached('cmd', ['/c', 'start', '', fileUrl]);
    return;
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [fileUrl]);
    return;
  }
  await spawnDetached('xdg-open', [fileUrl]);
}
```

Use `pathToFileURL` from `node:url`. Implement `spawnDetached` with `stdio: 'ignore'` and `detached: true` / `unref()`.

In `createProgram`, disable the default help command and register:

```ts
program
  .command('help [topic]')
  .description('Show CLI help, or open offline HTML help.')
  .option('--html', 'open offline HTML help in the default browser')
  .option('--path', 'print the offline HTML help directory')
  .action(async (topic: string | undefined, options: { html?: boolean; path?: boolean }) => {
    await executeHelp(topic, options, context, dependencies);
  });
```

When neither `--html` nor `--path`: if `topic` is set, call Commander’s help for that subcommand (reuse `program.helpInformation` / find command); if unset, print root help — same as today. Do **not** regress `sheldon help init` text output.

When `--path`: write `resolveHelpRoot() + '\n'` to stdout, exit 0.  
When `--html`: resolve page, open browser, write nothing required (or one line `Opened …`), exit 0.  
Unknown topic with `--html`: exit non-zero with `HELP_PAGE_MISSING` and recovery naming `sheldon help --path`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/cli/test/help.test.ts apps/cli/test/main.test.ts apps/cli/test/cli.test.ts`  
Expected: PASS; existing help text tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/help.ts apps/cli/src/main.ts apps/cli/test/help.test.ts
git commit -m "feat(cli): open offline html help with sheldon help --html"
```

---

### Task 3: Ingest, compile/review, and search/query pages

**Files:**

- Create/modify: `apps/cli/help/pages/ingest.md`
- Create: `apps/cli/help/pages/compile.md`, `review.md`, `search.md`, `query.md`, `answer.md`
- Create: `apps/cli/help/pages/flow-compile-review.md`
- Modify: `apps/cli/help/manifest.json`, `apps/cli/help/pages/index.md`

**Interfaces:**

- Consumes: Task 1 builder.
- Produces: HTML pages covering commands `ingest`, `compile`, `compile-retry`, `review`, `search`, `query`, `answer`.

- [ ] **Step 1: Write a failing coverage assertion**

Extend `apps/cli/test/help-build.test.ts` (or add `help-manifest.test.ts`):

```ts
import manifest from '../../help/manifest.json';

const required = ['ingest', 'compile', 'compile-retry', 'review', 'search', 'query', 'answer'];

it('covers ingest through answer commands in the manifest', () => {
  const covered = new Set(manifest.pages.flatMap((page) => page.commands));
  for (const command of required) expect(covered.has(command)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/help-manifest.test.ts`  
Expected: FAIL missing commands.

- [ ] **Step 3: Author the Markdown pages**

Each command page must include:

1. Purpose (2–4 sentences).
2. Synopsis.
3. Important flags / arguments.
4. At least one PowerShell example and one Unix example when paths differ; otherwise one `sh`/`powershell` pair or a single portable block.
5. Expected outputs / artifacts (e.g. `raw/…`, proposal id).
6. Common failures + recovery (plugin missing, vault path, agent not logged in).

`flow-compile-review.md`: end-to-end from raw → `compile` → `review preview` → `review approve`.

Update `index.md` with links to these pages.

- [ ] **Step 4: Rebuild help and run tests**

Run: `node scripts/build-cli-help.mjs && npx vitest run apps/cli/test/help-manifest.test.ts apps/cli/test/help-build.test.ts`  
Expected: PASS; HTML files present under `dist/help/pages/`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/help apps/cli/test/help-manifest.test.ts
git commit -m "docs(cli): add html help for ingest compile review and query"
```

---

### Task 4: Remaining command groups + full E2E flow + full coverage gate

**Files:**

- Create: `apps/cli/help/pages/topic.md`, `project.md`, `doctor.md`, `migrate-state.md`, `web.md`, `plugin.md`, `agent.md`, `mcp.md`, `bundle.md`, `image.md`
- Create: `apps/cli/help/pages/flow-end-to-end.md`
- Modify: `apps/cli/help/manifest.json`, `apps/cli/help/pages/index.md`
- Modify: `apps/cli/test/help-manifest.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: every top-level command in the Global Constraints inventory covered by ≥1 manifest page; one E2E flow from `init` → ingest → compile → approve → `search`/`query`.

- [ ] **Step 1: Write the full coverage failing test**

```ts
const TOP_LEVEL = [
  'init',
  'doctor',
  'migrate-state',
  'web',
  'topic',
  'project',
  'ingest',
  'compile',
  'compile-retry',
  'review',
  'bundle',
  'search',
  'query',
  'answer',
  'agent',
  'mcp',
  'plugin',
  'image',
] as const;

it('covers every top-level sheldon command group', () => {
  const covered = new Set(manifest.pages.flatMap((page) => page.commands));
  expect([...TOP_LEVEL].sort()).toEqual([...covered].sort());
});

it('includes an end-to-end flow page', () => {
  expect(manifest.pages.some((page) => page.id === 'flow-end-to-end')).toBe(true);
});
```

Until pages exist, either keep `commands` incomplete (test fails) or add pages in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/help-manifest.test.ts`  
Expected: FAIL on missing commands / flow page.

- [ ] **Step 3: Author remaining pages**

Requirements per page: same structure as Task 3.  
`flow-end-to-end.md` must show a concrete happy path including:

- `sheldon init`
- one ingest (file or url)
- `compile` with `--agent`
- `review preview` / `review approve`
- `search` and a `query` sketch

Document explicitly: Sheldon does **not** list vaults; only the saved default and `--vault`.

- [ ] **Step 4: Run coverage + help build tests**

Run: `node scripts/build-cli-help.mjs && npx vitest run apps/cli/test/help-manifest.test.ts apps/cli/test/help-build.test.ts apps/cli/test/help.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/help apps/cli/test/help-manifest.test.ts
git commit -m "docs(cli): complete offline html help for all command groups"
```

---

### Task 5: User-facing docs and verify

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/README.md`

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces: users discover `sheldon help --html` from the README; changelog Unreleased notes the feature.

- [ ] **Step 1: Update README install/getting-started**

After the install block, add:

````markdown
### Ajuda detalhada (HTML, offline)

```powershell
sheldon help --html
sheldon help --html init
sheldon help --path
```

Abre o guia HTML instalado com a CLI (sem rede). O `--help` do terminal continua curto.
````

Link the plan from `docs/README.md`.

- [ ] **Step 2: Changelog**

Under `[Unreleased] ### Added`:

```markdown
- Ajuda HTML offline com exemplos e fluxos (`sheldon help --html`), gerada a partir de
  Markdown em `apps/cli/help/` e empacotada em `apps/cli/dist/help/`.
```

- [ ] **Step 3: Full verify**

Run: `npm run verify`  
Expected: PASS.

Manual smoke on this machine:

```powershell
npm run build
npm run sheldon -- help --path
npm run sheldon -- help --html
```

Expected: path under `apps/cli/dist/help`; browser opens (or opener invoked).

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md docs/README.md
git commit -m "docs(cli): advertise offline html help"
```

---

## Spec coverage (issue #26)

| Requirement                                                                            | Task                          |
| -------------------------------------------------------------------------------------- | ----------------------------- |
| HTML more detailed than `--help`                                                       | 1, 3, 4                       |
| Example-heavy (PowerShell + Unix)                                                      | 3, 4                          |
| Flows: first vault, ingest, compile/review, search/query, plugins/agents, MCP, bundles | 1, 3, 4                       |
| Offline after install                                                                  | 1 (dist/help) + npm closure   |
| Discoverable (`sheldon help --html`)                                                   | 2, 5                          |
| Do not replace Commander help                                                          | 2                             |
| Avoid drift: stubs/inventory from manifest                                             | 1, 4 coverage gate            |
| Document no vault list / `--vault`                                                     | 1 (`index` + `init`), 4 (E2E) |
| Not a web tutorial app                                                                 | Global + static HTML only     |

## Placeholders / decisions locked

- Converter is custom (no new runtime/build dependency) unless a later task proves insufficient; do not add `marked` without an ADR/dependency review.
- Topic ids in URLs are manifest `id` values (`init`, `flow-end-to-end`), not arbitrary paths.
- Next npm release that includes this work is whatever SemVer follows `0.2.0` (likely `0.2.1`); this plan does not cut a tag.
