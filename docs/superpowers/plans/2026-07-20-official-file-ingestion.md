# Official File Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Route the file-ingest CLI through a bundled official plugin and atomically publish deduplicated raw captures.

**Architecture:** sheldon.file owns probing and local extraction. The CLI obtains a validated host lease; @sheldon/ingestion is the trusted writer of raw/<source-id>, manifests and version links.

**Tech Stack:** Node.js 24+, TypeScript 6, Vitest 4, Plugin SDK/Host v1, pdfjs-dist, mammoth, xlsx, turndown, jszip, fast-xml-parser and YAML.

## Global Constraints

- The CLI receives entity kind and file path, never a file-format argument.
- No test, healthcheck or extractor calls network or a paid API.
- The plugin declares network: false and cookies: false.
- Standard converters are workspace libraries. Tesseract/models are optional and never downloaded automatically.
- Plugins only write host-owned temporary artifacts; the host validates them and trusted code writes the vault.
- Identity is SHA-256(original bytes + newline + stable JSON relevant options).
- Preserve M2 raw readability and the command spelling: sheldon ingest file <entity-kind> <slug> <file>.
- Any user-visible change updates CHANGELOG.md and the closest README.

---

## File map

| Path                                                                                                              | Responsibility                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| packages/plugins/official/sheldon.file/src/index.ts                                                               | Exports the protocol implementation.                                   |
| packages/plugins/official/sheldon.file/src/plugin.ts                                                              | describe, probe, ingest, healthcheck and cancel.                       |
| packages/plugins/official/sheldon.file/src/extractors.ts                                                          | Deterministic format registry.                                         |
| packages/plugins/official/sheldon.file/src/markdown.ts                                                            | HTML, structured-data and table normalization.                         |
| packages/plugins/official/sheldon.file/{package.json,sheldon-plugin.json,plugin.mjs,sheldon-plugin.contract.json} | Distributed plugin package, manifest, executable and contract fixture. |
| packages/ingestion/src/plugin-file-ingestor.ts                                                                    | Validated lease to raw publisher and version linkage.                  |
| apps/cli/src/plugin-services.ts                                                                                   | Shared discovery, selector and runner lifetime.                        |
| apps/cli/src/commands/memory.ts                                                                                   | Selection, runner invocation and raw publication.                      |
| apps/cli/src/main.ts                                                                                              | --plugin option and bundled-root default.                              |
| scripts/build.mjs                                                                                                 | Plugin compile and resource copy.                                      |
| test-fixtures/ingestion/files/*                                                                                   | Offline fixture per supported input type.                              |

## Task 1: Bundle and expose the official plugin

**Files:**

- Create: packages/plugins/official/sheldon.file/package.json
- Create: packages/plugins/official/sheldon.file/src/index.ts
- Create: packages/plugins/official/sheldon.file/src/plugin.ts
- Create: packages/plugins/official/sheldon.file/test/plugin.test.ts
- Create: packages/plugins/official/sheldon.file/sheldon-plugin.json
- Create: packages/plugins/official/sheldon.file/plugin.mjs
- Create: packages/plugins/official/sheldon.file/sheldon-plugin.contract.json
- Modify: package.json, package-lock.json, tsconfig.json, vitest.config.ts and scripts/build.mjs

**Interfaces:** Export createOfficialFilePlugin(dependencies?) and runOfficialFilePlugin(). The manifest id is sheldon.file, capability ingest-file, priority 100, platform list win32/darwin/linux, node >=24 required and tesseract optional.

- [ ] **Step 1: Write the failing protocol tests**

```ts
it('describes an offline official file plugin', async () => {
  await expect(createOfficialFilePlugin().describe(context)).resolves.toMatchObject({
    id: 'sheldon.file',
    capabilities: ['ingest-file'],
    permissions: { network: false, cookies: false },
  });
});

it('accepts a regular Markdown file and declines a missing path', async () => {
  await expect(plugin.probe({ input: { filePath: markdownPath } }, context)).resolves.toMatchObject(
    { supported: true, confidence: 100 },
  );
  await expect(plugin.probe({ input: { filePath: missingPath } }, context)).resolves.toMatchObject({
    supported: false,
  });
});
```

- [ ] **Step 2: Verify red**

Run: npm test -- --run packages/plugins/official/sheldon.file/test/plugin.test.ts

Expected: FAIL because the workspace and exports do not exist.

- [ ] **Step 3: Implement the minimal scaffold**

Make packages/plugins/official/sheldon.file its own private workspace package, named @sheldon/plugin-file and depending on @sheldon/plugin-sdk. Add packages/plugins/official/* to root workspaces, a source alias, a SWC build target and a resource copy to apps/cli/dist/plugins/official. Its plugin.mjs imports ./dist/index.js. Its JSON manifest uses node plugin.mjs, has network and cookies false, and declares the required Node runtime plus optional executable tesseract.

```ts
export function createOfficialFilePlugin(): PluginImplementation {
  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeFile(input),
    ingest: async () => {
      throw new Error('FILE_EXTRACTOR_UNAVAILABLE');
    },
    healthcheck: async () => ({ checks: [nodeCheck()] }),
    cancel: async () => undefined,
  });
}
export async function runOfficialFilePlugin(): Promise<void> {
  await runPlugin(createOfficialFilePlugin());
}
```

- [ ] **Step 4: Verify green**

Run: npm test -- --run packages/plugins/official/sheldon.file/test/plugin.test.ts

Expected: PASS for describe and probe.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts scripts/build.mjs packages/plugins/official/sheldon.file
git commit -m "feat(file-plugin): add official plugin scaffold"
```

## Task 2: Implement embedded extraction

**Files:**

- Create: packages/plugins/official/sheldon.file/src/extractors.ts
- Create: packages/plugins/official/sheldon.file/src/markdown.ts
- Create: packages/plugins/official/sheldon.file/test/extractors.test.ts
- Create: test-fixtures/ingestion/files/sample.{md,txt,html,json,yaml,pdf,docx,pptx,xlsx,epub,png}
- Modify: packages/plugins/official/sheldon.file/package.json, root package.json and package-lock.json

**Interfaces:**

```ts
export interface ExtractedFile {
  readonly format: FileFormat;
  readonly content: string;
  readonly status: 'complete' | 'gap';
  readonly warnings: readonly string[];
  readonly assets: readonly ExtractedAsset[];
}
export async function extractFile(input: ExtractFileInput): Promise<ExtractedFile>;
```

- [ ] **Step 1: Write the failing fixture tests**

```ts
it.each([
  ['sample.md', '# Heading\n\nBody', 'markdown'],
  ['sample.txt', '# sample.txt\n\nPlain body', 'text'],
  ['sample.html', '# HTML heading', 'html'],
  ['sample.json', '# sample.json\n\n## database', 'json'],
  ['sample.yaml', '# sample.yaml\n\n## service', 'yaml'],
  ['sample.pdf', '# sample.pdf\n\nPDF fixture', 'pdf'],
])('normalizes %s deterministically', async (fixture, expected, format) => {
  const first = await extractFile({ filePath: fixturePath(fixture), ocr: 'off' });
  const second = await extractFile({ filePath: fixturePath(fixture), ocr: 'off' });
  expect(first).toMatchObject({ format, status: 'complete' });
  expect(first.content).toContain(expected);
  expect(second).toEqual(first);
});

it('reports unavailable optional OCR without downloading', async () => {
  await expect(
    extractFile({ filePath: fixturePath('sample.png'), ocr: 'auto' }),
  ).resolves.toMatchObject({ format: 'image', status: 'gap' });
});
```

- [ ] **Step 2: Verify red**

Run: npm test -- --run packages/plugins/official/sheldon.file/test/extractors.test.ts

Expected: FAIL because extractFile and fixtures do not exist.

- [ ] **Step 3: Implement the single extractor registry**

Add production dependencies pdfjs-dist, mammoth, xlsx, turndown, jszip and fast-xml-parser; add declaration packages if the installed package lacks usable types. Sniff signatures before extensions. Normalize output to LF, trim trailing whitespace and add exactly one final newline.

Use Turndown for HTML; mammoth.convertToHtml then Turndown for DOCX; PDF.js page text for PDF; XLSX.read with one Markdown table per sheet; JSZip/fast-xml-parser for PPTX slide text and EPUB spine XHTML. Render JSON/YAML recursively with sorted keys. Invoke injected Tesseract only when available; otherwise image gets a gap warning. Unknown input gets a gap, never invented text.

```ts
const extractors: readonly Extractor[] = [
  pdf,
  docx,
  pptx,
  xlsx,
  epub,
  html,
  json,
  yaml,
  markdown,
  text,
  image,
  unsupported,
];
export async function extractFile(input: ExtractFileInput): Promise<ExtractedFile> {
  const bytes = await readFile(input.filePath);
  return extractorFor(bytes, extname(input.filePath)).extract({ ...input, bytes });
}
```

- [ ] **Step 4: Verify green and types**

Run: npm test -- --run packages/plugins/official/sheldon.file/test/extractors.test.ts

Expected: PASS with exact stable Markdown assertions and no timestamps, paths or library diagnostics.

Run: npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/plugins/official/sheldon.file test-fixtures/ingestion/files
git commit -m "feat(file-plugin): extract supported local formats"
```

## Task 3: Return protocol-valid temporary artifacts

**Files:**

- Modify: packages/plugins/official/sheldon.file/src/index.ts
- Modify: packages/plugins/official/sheldon.file/src/plugin.ts
- Modify: packages/plugins/official/sheldon.file/test/plugin.test.ts
- Create: packages/plugins/official/sheldon.file/test/contract.test.ts
- Modify: packages/plugins/official/sheldon.file/sheldon-plugin.contract.json
- Modify: scripts/verify-plugin-contract.mjs

**Interfaces:** Ingest receives input with filePath and canonicalUri plus options. It produces original, normalized and optional asset descriptors; normalized metadata includes format, extractionStatus, warnings, language and extractor.

- [ ] **Step 1: Write failing artifact and healthcheck tests**

```ts
it('writes original and normalized artifacts below the temporary root', async () => {
  const artifacts = await plugin.ingest(request(markdownPath, temporaryDirectory), context);
  expect(artifacts.map((artifact) => artifact.role)).toEqual(['original', 'normalized']);
  await expect(readFile(join(temporaryDirectory, 'content.md'), 'utf8')).resolves.toBe(
    '# Evidence\n',
  );
});

it('reports unavailable optional OCR without an install action', async () => {
  await expect(plugin.healthcheck(context)).resolves.toMatchObject({
    checks: expect.arrayContaining([
      expect.objectContaining({ id: 'tesseract', severity: 'warning' }),
    ]),
  });
});
```

- [ ] **Step 2: Verify red**

Run: npm test -- --run packages/plugins/official/sheldon.file/test/plugin.test.ts packages/plugins/official/sheldon.file/test/contract.test.ts

Expected: FAIL because scaffold ingest throws FILE_EXTRACTOR_UNAVAILABLE.

- [ ] **Step 3: Implement artifact materialization and diagnostics**

Copy source to original<extension>, write content.md and place assets only below assets/. Calculate byte length and SHA-256 after every write; descriptors must use relative paths and never timestamps or absolute paths. Map invalid input, unsupported format, required-but-missing OCR and library failures to FILE_INPUT_INVALID, FILE_FORMAT_UNSUPPORTED, FILE_OCR_UNAVAILABLE and FILE_EXTRACTION_FAILED.

```ts
return writtenArtifacts.map((artifact) => ({
  id: artifact.role + ':' + artifact.path,
  role: artifact.role,
  path: artifact.path,
  mediaType: artifact.mediaType,
  bytes: artifact.bytes,
  sha256: artifact.sha256,
  metadata: artifact.metadata,
}));
```

Healthcheck reports embedded capabilities as info, invalid Node as error and missing Tesseract as warning. It may call the injected command-availability probe, but never execute OCR or download a model.

- [ ] **Step 4: Verify protocol behavior**

Run: npm test -- --run packages/plugins/official/sheldon.file/test

Expected: PASS.

Run: npm run build && node scripts/verify-plugin-contract.mjs

Expected: Output includes sheldon.file: contract passed and the existing SDK fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/official/sheldon.file scripts/verify-plugin-contract.mjs
git commit -m "feat(file-plugin): expose extraction through plugin protocol"
```

## Task 4: Publish validated lease artifacts as raws

**Files:**

- Create: packages/ingestion/src/plugin-file-ingestor.ts
- Modify: packages/ingestion/src/index.ts
- Create: packages/ingestion/test/plugin-file-ingestor.test.ts
- Modify: packages/ingestion/test/local-file-ingestor.test.ts

**Interfaces:**

```ts
export async function publishPluginFileIngestion(
  input: PublishPluginFileInput,
  lease: IngestLease,
  dependencies?: PluginFileIngestorDependencies,
): Promise<PluginFileIngestionResult>;
```

The result has sourceId, rawPath, deduplicated and a manifest with plugin id/version, extractor/status/warnings, artifact hashes and optional previous_source_id.

- [ ] **Step 1: Write failing publisher tests**

```ts
it('atomically publishes original, normalized content, assets and plugin metadata', async () => {
  const result = await publishPluginFileIngestion(input, fixtureLease, fixedClock);
  await expect(readFile(join(result.rawPath, 'original.pdf'))).resolves.toEqual(pdfBytes);
  await expect(readFile(join(result.rawPath, 'content.md'), 'utf8')).resolves.toBe(
    '# PDF fixture\n',
  );
  expect(result.manifest).toMatchObject({ plugin: 'sheldon.file', plugin_version: '1.0.0' });
});

it('deduplicates equal input and links changed bytes for the same URI', async () => {
  const first = await publishPluginFileIngestion(input, lease('v1'), fixedClock);
  const duplicate = await publishPluginFileIngestion(input, lease('v1'), fixedClock);
  const next = await publishPluginFileIngestion(input, lease('v2'), fixedClock);
  expect(duplicate).toMatchObject({ deduplicated: true, sourceId: first.sourceId });
  expect(next.manifest.previous_source_id).toBe(first.sourceId);
});

it('does not publish when normalized is absent', async () => {
  await expect(
    publishPluginFileIngestion(input, leaseWithoutNormalized, fixedClock),
  ).rejects.toMatchObject({ code: 'PLUGIN_FILE_ARTIFACT_REQUIRED' });
  await expect(readdir(rawDirectory)).resolves.toEqual([]);
});
```

- [ ] **Step 2: Verify red**

Run: npm test -- --run packages/ingestion/test/plugin-file-ingestor.test.ts

Expected: FAIL because publisher does not exist.

- [ ] **Step 3: Implement trusted atomic publication**

Reuse stable JSON, SHA-256, staging and winner-on-rename race logic from local-file-ingestor.ts. Require one validated original and one normalized descriptor, copy only validated assets below assets/, write manifest.yaml before the staging rename. Scan valid raw manifests for latest matching canonical_uri and options_sha256 to set previous_source_id; do not create a mutable index. Keep LocalFileIngestor exported and accept legacy M2 manifests lacking extractor/version fields. Raise PluginFileIngestionError for missing or duplicate required roles, malformed historical manifest, source identity conflict and assets path escape.

- [ ] **Step 4: Verify race and legacy compatibility**

Run: npm test -- --run packages/ingestion/test/local-file-ingestor.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts

Expected: PASS, including Promise.all concurrent publish returning one source identity.

Run: npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ingestion
git commit -m "feat(ingestion): publish plugin file captures atomically"
```

## Task 5: Route the CLI through selection and the host lease

**Files:**

- Create: apps/cli/src/plugin-services.ts
- Modify: apps/cli/src/commands/plugins.ts
- Modify: apps/cli/src/commands/memory.ts
- Modify: apps/cli/src/main.ts
- Modify: apps/cli/src/runtime.ts
- Create: apps/cli/test/file-ingestion-acceptance.test.ts
- Modify: apps/cli/test/cli.test.ts
- Modify: apps/cli/test/m2-acceptance.test.ts
- Modify: scripts/build.mjs

**Interfaces:** ingestFile(kind, slug, file, options containing vault/plugin, context) uses discovery, selector, runner and publishPluginFileIngestion. CLI adds --plugin <id>.

- [ ] **Step 1: Write failing public-flow tests**

```ts
it('selects bundled file plugin without a format argument', async () => {
  const result = await runCli(
    ['ingest', 'file', 'topic', 'memory', markdownPath, '--vault', vault],
    bundledPluginDependencies(root),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ manifest: { plugin: 'sheldon.file' } });
});

it('honors a compatible override and rejects a missing override', async () => {
  await expect(runCli([...base, '--plugin', 'sheldon.file'], dependencies)).resolves.toMatchObject({
    exitCode: 0,
  });
  await expect(
    runCli([...base, '--plugin', 'missing.plugin'], dependencies),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('PLUGIN_OVERRIDE_INVALID'),
  });
});

it('rejects a directory before starting a plugin', async () => {
  await expect(runCli([...baseWithoutInput, directoryPath], dependencies)).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('regular file'),
  });
});
```

- [ ] **Step 2: Verify red**

Run: npm test -- --run apps/cli/test/file-ingestion-acceptance.test.ts apps/cli/test/m2-acceptance.test.ts

Expected: FAIL because memory.ts calls ingestLocalFile directly and the command has no --plugin option.

- [ ] **Step 3: Implement services and routed ingestion**

Move state/registry/discovery/runner construction from commands/plugins.ts to plugin-services.ts and guarantee state.close in finally. In memory.ts, resolve and lstat/realpath input, select capability ingest-file with optional override, invoke runner.ingest and publish inside the lease callback.

```ts
return services.runner.ingest(
  selection.plugin,
  { filePath: sourcePath, canonicalUri: pathToFileURL(sourcePath).href },
  normalizedOptions,
  (lease) =>
    publishPluginFileIngestion(
      {
        filePath: sourcePath,
        rawDirectory,
        plugin: selection.plugin.manifest,
        options: normalizedOptions,
      },
      lease,
    ),
);
```

Add the Commander option --plugin <id>. Resolve the default official root from build-copied dist/plugins/official via import.meta.url, preserving CliDependencies.officialPluginRoots for tests. Map ambiguous selection and directory, symlink or unreadable input to stable actionable failures before a process starts.

- [ ] **Step 4: Verify integration and M2 flow**

Run: npm run build && npm test -- --run apps/cli/test/file-ingestion-acceptance.test.ts apps/cli/test/m2-acceptance.test.ts packages/plugin-host/test/selector.test.ts

Expected: PASS. M2 still compiles both agents from new raw/content.md.

- [ ] **Step 5: Commit**

```bash
git add apps/cli scripts/build.mjs
git commit -m "feat(cli): ingest files through official plugins"
```

## Task 6: Document and verify the file-family deliverable

**Files:**

- Modify: README.md
- Create: packages/ingestion/README.md
- Modify: CHANGELOG.md
- Modify: docs/roadmap.md
- Modify: apps/cli/test/file-ingestion-acceptance.test.ts

- [ ] **Step 1: Add the diagnostic acceptance test**

```ts
it('reports OCR remediation through plugin doctor', async () => {
  const result = await runCli(['plugin', 'doctor', 'sheldon.file'], dependenciesWithoutTesseract);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('Install Tesseract and the requested language model');
});
```

- [ ] **Step 2: Verify behavior before prose**

Run: npm test -- --run apps/cli/test/file-ingestion-acceptance.test.ts

Expected: PASS. If it fails, correct diagnostic behavior before documenting it.

- [ ] **Step 3: Update exact docs**

Document automatic probe, --plugin, raw layout, supported formats, no-network guarantee, deduplication, version link and OCR remediation in README. Document trusted publisher boundary and manifest fields in packages/ingestion/README.md. Add user-facing Unreleased changelog entry. Mark only PRD 003 files family complete in roadmap; do not mark M3 complete.

- [ ] **Step 4: Run complete quality gate**

Run: npm run verify

Expected: PASS: formatting, lint, typecheck, Markdown lint, tests, coverage, build, contracts, domain/repository checks and git diff --check.

- [ ] **Step 5: Commit**

```bash
git add README.md packages/ingestion/README.md CHANGELOG.md docs/roadmap.md apps/cli/test/file-ingestion-acceptance.test.ts
git commit -m "docs(ingestion): document official file ingestion"
```

## Plan Self-Review

| Design requirement                          | Tasks      |
| ------------------------------------------- | ---------- |
| Official selection and explicit override    | 1, 3, 5    |
| Embedded conversion matrix                  | 2          |
| Optional OCR and healthcheck                | 2, 3, 6    |
| Validated host artifacts and trusted writer | 3, 4, 5    |
| Atomic raws, dedupe and version links       | 4          |
| Offline fixtures and actionable errors      | 2, 3, 4, 5 |
| M2 continuity                               | 4, 5       |
| Documentation and complete gate             | 6          |

All design requirements map to a task; every implementation task starts with a failing test and ends with a focused commit.
