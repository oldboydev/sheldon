# Official Catalog and Image OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bundled official plugins and system Tesseract OCR with an optional, signed GitHub Release catalog and a self-contained `source.image` plugin with managed language models.

**Architecture:** `@sheldon/plugin-host` becomes the trusted catalog, artifact-verification, archive-extraction, and registry-install boundary; the CLI supplies the pinned GitHub-release policy and public key. `source.file` and `source.image` become separate installable plugin archives, with image-language data owned by the registered `source.image` root. Release tooling builds every supported archive, catalog, signature, SBOM, and notices without placing the signing private key in the checkout or a package.

**Tech Stack:** Node.js 24+, TypeScript 6, Vitest 4, Commander 15, Node `crypto` Ed25519 verification, JSZip, YAML, existing Plugin SDK/Host registry and process protocol.

## Global Constraints

- Official catalog endpoints and artifacts are HTTPS URLs under `https://github.com/oldboydev/sheldon/releases/download/`; no arbitrary catalog, artifact, model, npm, pip, package-manager, or system-Tesseract URL is accepted.
- `catalog.json` has schema version `1`, a strictly valid ISO-8601 `publishedAt`, unique lowercase dot-separated plugin IDs and language codes, platform records, exact SHA-256 hashes, and bounded byte counts.
- The embedded Ed25519 public key verifies detached `catalog.sig` before any remote catalog entry is displayed or used.
- `sheldon plugin list` is local-only; `--remote` is the explicit network opt-in for list and info. `plugin install <id>` and `image language install <code>` are explicit network operations only.
- Downloaded artifacts are bounded, byte-count and SHA-256 verified, extracted only as regular files below a private temporary root, manifest-validated, and installed through the existing locked/staged registry path. No plugin code executes during installation.
- Installed plugins are never overwritten. Discovery diagnostics for an existing manifest/digest mismatch remain authoritative.
- `source.file` owns only local text, document, archive, structured-data, and HTML inputs. `source.image` alone claims image inputs and embeds its own Tesseract runtime plus mandatory `por` and `eng` models; its default OCR language is `por+eng`.
- `por` and `eng` cannot be removed. Additional image languages are catalog-defined `.traineddata` files in `<source.image root>/data/tessdata/`, with an atomic local registry and no `PATH` or operating-system Tesseract mutation.
- Source ingestion may use network only during a user-initiated ingest when the manifest declares `permissions.network: true`; `source.file` and `source.image` declare `false`.
- All tests inject fetch, signature verification, archive extraction, platform, clock, and temporary-root dependencies. Tests never access GitHub or download Tesseract.
- Every user-visible change updates `README.md`, `CHANGELOG.md`, and the closest package README; maintain M2 raw compatibility and the existing `npm run verify` quality gate.

---

## File map

| Path                                                                                     | Responsibility                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/plugin-host/src/official-catalog.ts`                                           | Catalog types, strict schema parsing, release-host policy, detached-signature verification, and artifact selection.                                                |
| `packages/plugin-host/src/official-download.ts`                                          | Injected fetch client, bounded streaming download, byte/hash validation, and safe ZIP extraction.                                                                  |
| `packages/plugin-host/src/official-installer.ts`                                         | Connects a verified plugin archive to `PluginRegistry.install` without executing plugin code.                                                                      |
| `packages/plugin-host/src/registry.ts`                                                   | Adds a verified installed-plugin lookup for image-language ownership while preserving atomic registry behavior.                                                    |
| `packages/plugin-host/test/official-*.test.ts`                                           | Offline hostile-catalog, signature, download, archive, installation, and registry-integrity coverage.                                                              |
| `apps/cli/src/official-catalog.ts`                                                       | Pinned release names, public-key loading, and CLI dependency factory for the official catalog service.                                                             |
| `apps/cli/src/commands/plugins.ts`                                                       | Local/remote list and info, catalog-based plugin installation, and local-only removal/doctor behavior.                                                             |
| `apps/cli/src/commands/images.ts`                                                        | `sheldon image language list`, `install`, and `remove` command implementation.                                                                                     |
| `apps/cli/src/main.ts`, `apps/cli/src/runtime.ts`, `apps/cli/src/plugin-services.ts`     | Commander wiring, injected test dependencies, and catalog/image-language services.                                                                                 |
| `apps/cli/test/plugins.test.ts`, `apps/cli/test/images.test.ts`                          | CLI acceptance tests proving explicit network behavior and stable diagnostics.                                                                                     |
| `packages/plugins/official/source.file/**`                                               | Renamed, image-free offline file plugin and its contract/extractor tests.                                                                                          |
| `packages/plugins/official/source.image/**`                                              | Image-only plugin, packaged Tesseract launcher, model registry, base-model checks, and OCR tests.                                                                  |
| `packages/plugins/official/source.url/**`, `packages/plugins/official/source.youtube/**` | Catalog-visible source package manifests with explicit network permission and protocol/health scaffolds; their ingest feature work remains in their own milestone. |
| `scripts/release/build-official-artifacts.mjs`                                           | Produces deterministic platform plugin ZIPs, catalog records, SBOM, and notices from staged release inputs.                                                        |
| `scripts/release/sign-official-catalog.mjs`                                              | Signs `catalog.json` only from a CI-provided private-key environment variable; it never writes that key to disk.                                                   |
| `scripts/release/verify-official-release.mjs`                                            | Validates every release artifact, catalog signature, manifest digest, notices/SBOM, and packaged image runtime.                                                    |
| `scripts/release/test/**`, `release/official-catalog-public.pem`                         | Offline release fixtures/tests and the non-secret compiled public verification key.                                                                                |
| `scripts/build.mjs`, `tsconfig.json`, `vitest.config.ts`, root/package manifests         | New workspaces, aliases, compiled assets, and release-verification scripts.                                                                                        |
| `README.md`, `CHANGELOG.md`, `docs/roadmap.md`, `packages/ingestion/README.md`           | Updated optional-installation, OCR ownership, release/trust, and raw-format documentation.                                                                         |

### Task 1: Add the verified official catalog boundary

**Files:**

- Create: `packages/plugin-host/src/official-catalog.ts`
- Create: `packages/plugin-host/test/official-catalog.test.ts`
- Modify: `packages/plugin-host/src/index.ts`
- Modify: `packages/plugin-host/package.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`

**Interfaces:**

```ts
export type OfficialPlatform = 'win32-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64';
export interface OfficialArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface OfficialPluginCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly platforms: readonly OfficialPlatform[];
  readonly artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>;
  readonly description: string;
}
export interface OfficialLanguageCatalogEntry {
  readonly owner: 'source.image';
  readonly code: string;
  readonly artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>;
}
export interface OfficialCatalog {
  readonly schemaVersion: 1;
  readonly publishedAt: string;
  readonly plugins: readonly OfficialPluginCatalogEntry[];
  readonly languages: readonly OfficialLanguageCatalogEntry[];
}
export interface OfficialCatalogVerifier {
  verify(catalog: Uint8Array, signature: Uint8Array): Promise<boolean>;
}
export function parseVerifiedOfficialCatalog(
  catalog: Uint8Array,
  signature: Uint8Array,
  verifier: OfficialCatalogVerifier,
): Promise<OfficialCatalog>;
export function selectOfficialArtifact(
  artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>,
  platform: OfficialPlatform,
): OfficialArtifact;
```

- [ ] **Step 1: Write the failing catalog-policy tests**

```ts
it('accepts a valid signed catalog and selects only the current platform artifact', async () => {
  const catalog = await parseVerifiedOfficialCatalog(
    bytes(validCatalog),
    bytes('signature'),
    verifier(true),
  );
  expect(selectOfficialArtifact(catalog.plugins[0]!.artifacts, 'win32-x64')).toMatchObject({
    url: 'https://github.com/oldboydev/sheldon/releases/download/source.file-1.0.0/source.file-win32-x64.zip',
    sha256: 'a'.repeat(64),
    bytes: 4096,
  });
});

it.each([
  'http://github.com/oldboydev/sheldon/releases/download/x/a.zip',
  'https://example.test/a.zip',
])('rejects artifact URL outside the official release host: %s', async (url) => {
  await expect(
    parseVerifiedOfficialCatalog(bytes(catalogWith(url)), bytes('sig'), verifier(true)),
  ).rejects.toMatchObject({ code: 'OFFICIAL_CATALOG_ARTIFACT_URL_INVALID' });
});

it('rejects an invalid signature before parsing entries', async () => {
  await expect(
    parseVerifiedOfficialCatalog(bytes('{not json'), bytes('sig'), verifier(false)),
  ).rejects.toMatchObject({ code: 'OFFICIAL_CATALOG_SIGNATURE_INVALID' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run packages/plugin-host/test/official-catalog.test.ts`

Expected: FAIL because `official-catalog.ts` and its exported parser do not exist.

- [ ] **Step 3: Implement strict schema parsing and signature verification**

Create a single parser that first awaits `verifier.verify`, then parses UTF-8 JSON, rejects unknown top-level keys/schema versions, invalid or non-monotonic timestamps, duplicate IDs/codes, noncanonical identifiers, bad SemVer, missing platform-artifact pairs, bad 64-character lowercase hashes, non-positive/bounded byte counts, unsupported platforms, and non-release HTTPS URLs. Return frozen records sorted by ID/code so rendering and tests are stable. Export `officialCatalogError(code, message)` as a `PluginHostError` targeted at `official-catalog` with recovery `Retry after checking the official Sheldon release catalog.`

```ts
const RELEASE_PREFIX = 'https://github.com/oldboydev/sheldon/releases/download/';
export async function parseVerifiedOfficialCatalog(
  catalog: Uint8Array,
  signature: Uint8Array,
  verifier: OfficialCatalogVerifier,
): Promise<OfficialCatalog> {
  if (!(await verifier.verify(catalog, signature)))
    throw officialCatalogError(
      'OFFICIAL_CATALOG_SIGNATURE_INVALID',
      'The official catalog signature is invalid.',
    );
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalog));
  return freezeCatalog(parseCatalogDocument(value));
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- --run packages/plugin-host/test/official-catalog.test.ts && npm run typecheck`

Expected: PASS, including malformed JSON, signature failure, duplicate IDs/codes, unknown schemas, malformed checksum/count/platform, hostile host/path, and unsupported-platform selection cases.

- [ ] **Step 5: Commit the catalog contract**

```bash
git add packages/plugin-host/src/official-catalog.ts packages/plugin-host/test/official-catalog.test.ts packages/plugin-host/src/index.ts packages/plugin-host/package.json tsconfig.json vitest.config.ts
git commit -m "feat(plugin-host): validate signed official catalogs"
```

### Task 2: Download, verify, extract, and atomically install catalog artifacts

**Files:**

- Create: `packages/plugin-host/src/official-download.ts`
- Create: `packages/plugin-host/src/official-installer.ts`
- Create: `packages/plugin-host/test/official-download.test.ts`
- Create: `packages/plugin-host/test/official-installer.test.ts`
- Modify: `packages/plugin-host/src/registry.ts`
- Modify: `packages/plugin-host/src/index.ts`

**Interfaces:**

```ts
export interface OfficialFetch { fetch(url: string): Promise<{ readonly status: number; readonly body: AsyncIterable<Uint8Array> }>; }
export interface OfficialArchiveExtractor { extract(zipBytes: Uint8Array, destination: string): Promise<void>; }
export async function downloadOfficialArtifact(artifact: OfficialArtifact, fetcher: OfficialFetch): Promise<Uint8Array>;
export async function installOfficialPlugin(input: { readonly entry: OfficialPluginCatalogEntry; readonly platform: OfficialPlatform; readonly registry: PluginRegistry; readonly fetcher: OfficialFetch; readonly temporaryRoot: string; readonly extractor?: OfficialArchiveExtractor; readonly reservedIds: ReadonlySet<string>; }): Promise<InstalledPlugin>;
public async getInstalled(id: string): Promise<InstalledPlugin>;
```

- [ ] **Step 1: Write the failing hostile-download and install tests**

```ts
it('streams an exact official artifact and rejects an oversized or hash-mismatched response before extraction', async () => {
  await expect(
    downloadOfficialArtifact(artifact({ bytes: 3, sha256: sha256('abc') }), fetchOf('abc')),
  ).resolves.toEqual(bytes('abc'));
  await expect(
    downloadOfficialArtifact(artifact({ bytes: 2, sha256: sha256('abc') }), fetchOf('abc')),
  ).rejects.toMatchObject({ code: 'OFFICIAL_ARTIFACT_SIZE_MISMATCH' });
  await expect(
    downloadOfficialArtifact(artifact({ bytes: 3, sha256: '0'.repeat(64) }), fetchOf('abc')),
  ).rejects.toMatchObject({ code: 'OFFICIAL_ARTIFACT_DIGEST_MISMATCH' });
});

it('leaves no registry record or plugin directory when archive extraction contains traversal', async () => {
  await expect(installOfficialPlugin(hostileInstallInput('../escape.txt'))).rejects.toMatchObject({
    code: 'OFFICIAL_ARCHIVE_PATH_ESCAPE',
  });
  expect(registry.listRecords()).toEqual([]);
  await expect(access(join(appRoot, 'plugins', 'source.image'))).rejects.toThrow();
});

it('does not overwrite a locally registered source.image whose manifest is unhealthy', async () => {
  await registry.install(existingSourceImage, new Set());
  await expect(installOfficialPlugin(validInstallInput(registry))).rejects.toMatchObject({
    code: 'PLUGIN_ID_COLLISION',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts`

Expected: FAIL because the download/install services and `PluginRegistry.getInstalled` do not exist.

- [ ] **Step 3: Implement the trusted artifact path**

Stream only a previously catalog-validated URL, stop immediately after `bytes + 1`, calculate SHA-256 while streaming, and map non-200, missing body, size, and digest failures to stable `OFFICIAL_ARTIFACT_*` errors. Extract ZIP entries to a private `mkdtemp` child using JSZip; reject absolute, empty, dot, `..`, backslash/drive-prefixed, duplicate, symlink, device, and oversized entries, then write regular files with mode `0o600`. Require one top-level plugin root containing `sheldon-plugin.json`, call `loadPluginManifest` before and after extraction, require exact catalog ID/version, and delegate publication to `registry.install(extractedRoot, reservedIds)`.

Add `getInstalled(id)` under the existing registry transaction: resolve only the exact recorded child, load its manifest as `installed`, require its current digest/version to equal the record, and raise `PLUGIN_INSTALLATION_TAMPERED` without changing state when it does not. It is the sole API used by image-language operations.

```ts
const artifactBytes = await readBoundedResponse(artifact, fetcher);
if (createHash('sha256').update(artifactBytes).digest('hex') !== artifact.sha256) {
  throw officialArtifactError(
    'OFFICIAL_ARTIFACT_DIGEST_MISMATCH',
    'The official artifact digest does not match the signed catalog.',
  );
}
await extractor.extract(artifactBytes, extractedRoot);
const manifest = await loadPluginManifest(extractedRoot, 'installed');
if (manifest.manifest.id !== entry.id || manifest.manifest.version !== entry.version)
  throw officialArtifactError(
    'OFFICIAL_ARCHIVE_MANIFEST_MISMATCH',
    'The archive manifest does not match its catalog entry.',
  );
return registry.install(extractedRoot, reservedIds);
```

- [ ] **Step 4: Run focused verification**

Run: `npm test -- --run packages/plugin-host/test/registry.test.ts packages/plugin-host/test/official-download.test.ts packages/plugin-host/test/official-installer.test.ts && npm run typecheck`

Expected: PASS, including interrupted stream, bad status, size/hash failures, ZIP traversal/duplicate/symlink/extra-root cases, manifest mismatch, cleanup after every error, and existing concurrent registry coverage.

- [ ] **Step 5: Commit the installer boundary**

```bash
git add packages/plugin-host/src/official-download.ts packages/plugin-host/src/official-installer.ts packages/plugin-host/src/registry.ts packages/plugin-host/src/index.ts packages/plugin-host/test
git commit -m "feat(plugin-host): install verified official artifacts atomically"
```

### Task 3: Replace bundled-plugin CLI behavior with explicit local and remote catalog commands

**Files:**

- Create: `apps/cli/src/official-catalog.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/runtime.ts`
- Modify: `apps/cli/src/plugin-services.ts`
- Modify: `apps/cli/src/commands/plugins.ts`
- Modify: `apps/cli/test/plugins.test.ts`
- Create: `apps/cli/test/official-catalog-cli.test.ts`
- Modify: `scripts/build.mjs`

**Interfaces:**

```ts
export interface OfficialCatalogClient {
  load(): Promise<OfficialCatalog>;
  install(id: string, registry: PluginRegistry): Promise<InstalledPlugin>;
}
export interface CliDependencies {
  readonly officialCatalogClient?: OfficialCatalogClient;
  readonly platform?: OfficialPlatform;
}
export async function listPlugins(
  context: CommandContext,
  options: { readonly remote?: boolean },
): Promise<void>;
export async function infoPlugin(
  id: string,
  context: CommandContext,
  options: { readonly remote?: boolean },
): Promise<void>;
export async function installPlugin(id: string, context: CommandContext): Promise<void>;
```

- [ ] **Step 1: Write failing CLI behavior tests**

```ts
it('keeps plugin list local-only unless --remote is passed', async () => {
  const local = await runCli(['plugin', 'list'], dependencies);
  expect(local.exitCode).toBe(0);
  expect(fetch.calls).toEqual([]);

  const remote = await runCli(['plugin', 'list', '--remote'], dependencies);
  expect(remote.stdout).toContain('source.image\tnot installed');
  expect(fetch.calls).toEqual([catalogUrl, signatureUrl]);
});

it('requires --remote to inspect an uninstalled catalog entry and installs by ID only', async () => {
  await expect(runCli(['plugin', 'info', 'source.image'], dependencies)).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('PLUGIN_NOT_FOUND'),
  });
  await expect(
    runCli(['plugin', 'info', 'source.image', '--remote'], dependencies),
  ).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('source.image') });
  await expect(
    runCli(['plugin', 'install', 'https://example.test/evil.zip'], dependencies),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('OFFICIAL_PLUGIN_ID_INVALID'),
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run apps/cli/test/plugins.test.ts apps/cli/test/official-catalog-cli.test.ts`

Expected: FAIL because `plugin install` still accepts a local directory, `list` has no remote flag, and no catalog client is injected.

- [ ] **Step 3: Implement the catalog-backed CLI surface**

Embed only `release/official-catalog-public.pem` in the built CLI, construct exact `official-catalog/catalog.json` and `official-catalog/catalog.sig` URLs, and use `crypto.verify(null, catalog, publicKey, signature)` through the host verifier. Delete the default `bundledOfficialPluginRoot` behavior and do not copy plugin trees into `apps/cli/dist`; local discovery reads registry records only. Keep the existing local `plugin remove`, `doctor`, and `test` semantics, but allow removal of catalog-installed plugins because they are local registry entries.

Render local `list` with installed records/discovery only. Render remote entries in stable ID order with `installed` or `not installed`, version, description, platform availability, and local discovery issue when a same-ID registry record is invalid. `info` resolves installed records locally, or uses the remote catalog only with `--remote`; installing an unknown/non-ID catalog entry returns `OFFICIAL_PLUGIN_NOT_FOUND`. The remote option performs no registry write, and install performs no plugin process launch.

```ts
plugin
  .command('list')
  .option('--remote', 'load the signed official catalog')
  .action((options) => listPlugins(context, options));
plugin
  .command('info <id>')
  .option('--remote', 'load the signed official catalog')
  .action((id, options) => infoPlugin(id, context, options));
plugin.command('install <id>').action((id: string) => installPlugin(id, context));
```

- [ ] **Step 4: Run command and build verification**

Run: `npm run build && npm test -- --run apps/cli/test/plugins.test.ts apps/cli/test/official-catalog-cli.test.ts packages/plugin-host/test/official-catalog.test.ts`

Expected: PASS. The default CLI distribution contains no bundled plugin root; no test invokes live network access.

- [ ] **Step 5: Commit the optional-catalog CLI**

```bash
git add apps/cli scripts/build.mjs release/official-catalog-public.pem
git commit -m "feat(cli): install official plugins from signed catalog"
```

### Task 4: Split the current file package into image-free `source.file`

**Files:**

- Move: `packages/plugins/official/sheldon.file` to `packages/plugins/official/source.file`
- Modify: `packages/plugins/official/source.file/src/extractors.ts`
- Modify: `packages/plugins/official/source.file/src/plugin.ts`
- Modify: `packages/plugins/official/source.file/src/index.ts`
- Modify: `packages/plugins/official/source.file/{package.json,plugin.mjs,sheldon-plugin.json,sheldon-plugin.contract.json}`
- Modify: `packages/plugins/official/source.file/test/{plugin.test.ts,extractors.test.ts,contract.test.ts}`
- Modify: `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `scripts/verify-plugin-contract.mjs`, root `package.json`, `package-lock.json`
- Modify: `apps/cli/test/file-ingestion-acceptance.test.ts`

**Interfaces:**

```ts
export type FileFormat =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'epub'
  | 'html'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'text'
  | 'unsupported';
export function createOfficialSourceFilePlugin(
  dependencies?: OfficialSourceFileDependencies,
): PluginImplementation;
export async function extractFile(input: {
  readonly filePath: string;
  readonly bytes?: Uint8Array;
}): Promise<ExtractedFile>;
```

- [ ] **Step 1: Write failing separation tests**

```ts
it('declines PNG input so source.image is the sole image claimant', async () => {
  await expect(
    createOfficialSourceFilePlugin().probe({ input: { filePath: imagePath } }, context),
  ).resolves.toEqual({
    supported: false,
    confidence: 0,
    reason: 'The file format is not supported by this plugin.',
  });
});

it('has no Tesseract dependency, OCR option, or image extraction format', async () => {
  const description = await createOfficialSourceFilePlugin().describe(context);
  expect(description.id).toBe('source.file');
  expect(description.dependencies).not.toContainEqual(expect.objectContaining({ id: 'tesseract' }));
  await expect(extractFile({ filePath: imagePath })).resolves.toMatchObject({
    format: 'unsupported',
    status: 'gap',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run packages/plugins/official/source.file/test apps/cli/test/file-ingestion-acceptance.test.ts`

Expected: FAIL because the package is named `sheldon.file`, still exposes OCR, and claims images.

- [ ] **Step 3: Move and simplify the file plugin**

Rename the workspace/package/TypeScript alias and manifest identity to `source.file`, preserving every deterministic document extractor, archive limit, raw artifact contract, and no-network permission. Remove `TesseractAdapter`, image signatures/extensions/extractor, `ocr`/`language` validation and normalized metadata, executable command probing, temporary image snapshots, and the Tesseract healthcheck. Make its healthcheck report only required Node and embedded extractors. Its ingest options are an empty record, and attempts to pass OCR/image-only options fail as `FILE_INPUT_INVALID` rather than silently changing behavior.

Update the acceptance harness to install `source.file` from a catalog fixture before file ingest, proving optional install and preserving M2-compatible `original.*` plus `content.md` publication.

```ts
const description: PluginDescription = {
  id: 'source.file',
  name: 'Official file ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-file'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: false, cookies: false },
  dependencies: [nodeDependency],
};
```

- [ ] **Step 4: Run package, contract, and M2 regression tests**

Run: `npm run build && npm test -- --run packages/plugins/official/source.file/test apps/cli/test/file-ingestion-acceptance.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts && npm run verify:plugin-contract`

Expected: PASS. `source.file` produces the existing document fixtures, never selects an image, and no built or source artifact includes the legacy `sheldon.file` package.

- [ ] **Step 5: Commit the source-file boundary**

```bash
git add packages/plugins/official/source.file packages/plugins/official/sheldon.file tsconfig.json vitest.config.ts scripts package.json package-lock.json apps/cli/test
git commit -m "feat(source-file): separate document ingestion from OCR"
```

### Task 5: Implement the self-contained `source.image` runtime and language registry

**Files:**

- Create: `packages/plugins/official/source.image/src/{index.ts,plugin.ts,languages.ts,runtime.ts}`
- Create: `packages/plugins/official/source.image/{package.json,plugin.mjs,sheldon-plugin.json,sheldon-plugin.contract.json,THIRD_PARTY_NOTICES}`
- Create: `packages/plugins/official/source.image/data/tessdata/{por.traineddata,eng.traineddata}`
- Create: `packages/plugins/official/source.image/runtime/.gitkeep`
- Create: `packages/plugins/official/source.image/test/{plugin.test.ts,languages.test.ts,runtime.test.ts,contract.test.ts}`
- Modify: `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `scripts/verify-plugin-contract.mjs`, root `package.json`, `package-lock.json`

**Interfaces:**

```ts
export const BASE_IMAGE_LANGUAGES = ['por', 'eng'] as const;
export interface ImageLanguageRecord {
  readonly code: string;
  readonly catalogVersion: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly installedAt: string;
}
export async function listImageLanguages(root: string): Promise<readonly ImageLanguageRecord[]>;
export async function installImageLanguage(input: {
  readonly root: string;
  readonly entry: OfficialLanguageCatalogEntry;
  readonly catalogVersion: string;
  readonly fetcher: OfficialFetch;
  readonly platform: OfficialPlatform;
  readonly now: () => Date;
}): Promise<ImageLanguageRecord>;
export async function removeImageLanguage(root: string, code: string): Promise<void>;
export function createOfficialSourceImagePlugin(
  dependencies?: OfficialSourceImageDependencies,
): PluginImplementation;
```

- [x] **Step 1: Write failing image ownership, OCR, and language-registry tests**

```ts
it('claims only image signatures/extensions and runs its packaged binary with private tessdata and por+eng', async () => {
  const plugin = createOfficialSourceImagePlugin({ executable, run: captureRun, pluginRoot });
  await expect(plugin.probe({ input: { filePath: pngPath } }, context)).resolves.toMatchObject({
    supported: true,
    confidence: 100,
  });
  await expect(plugin.probe({ input: { filePath: markdownPath } }, context)).resolves.toMatchObject(
    { supported: false },
  );
  await plugin.ingest(request(pngPath), context);
  expect(captureRun).toHaveBeenCalledWith(
    executable,
    expect.arrayContaining([
      '--tessdata-dir',
      join(pluginRoot, 'data', 'tessdata'),
      '-l',
      'por+eng',
    ]),
    expect.objectContaining({ shell: false }),
  );
});

it('blocks OCR before process launch when a requested local language is absent', async () => {
  await expect(plugin.ingest(request(pngPath, { language: 'por+deu' }), context)).rejects.toThrow(
    'IMAGE_LANGUAGE_NOT_INSTALLED',
  );
  expect(captureRun).not.toHaveBeenCalled();
});

it('atomically installs an approved extra language, preserves it on failed replacement, and forbids base removal', async () => {
  await expect(removeImageLanguage(root, 'por')).rejects.toMatchObject({
    code: 'IMAGE_LANGUAGE_REQUIRED',
  });
  await expect(installImageLanguage(deuInput)).resolves.toMatchObject({
    code: 'deu',
    sha256: deuHash,
  });
  await expect(failingReplacement()).rejects.toMatchObject({
    code: 'OFFICIAL_ARTIFACT_DIGEST_MISMATCH',
  });
  await expect(readFile(join(root, 'data', 'tessdata', 'deu.traineddata'))).resolves.toEqual(
    deuBytes,
  );
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run packages/plugins/official/source.image/test`

Expected: FAIL because `source.image`, its bundled base models, and the language registry do not exist.

- [x] **Step 3: Implement image-only protocol and language storage**

Declare `source.image` with `network: false`, `cookies: false`, `ingest-file`, and dependencies for packaged `tesseract`, `por`, and `eng` assets. Resolve the executable strictly from `<pluginRoot>/runtime/<platform>/tesseract[.exe]`; never resolve a bare command or inherit system Tesseract. Copy the source image to a private operation temporary file, invoke `execFile`/injected runner with `shell: false`, `--tessdata-dir <pluginRoot>/data/tessdata`, `stdout`, and `-l por+eng` by default, then materialize normal host artifacts. Accept a caller language only as `^[a-z]{3}(\+[a-z]{3})*$`; every code must be base or in `data/languages.yaml` and have a regular matching `.traineddata` file.

Make healthcheck error when runtime/base models are missing or malformed and block OCR in the same condition. Implement `languages.ts` with safe lowercase code validation, a YAML schema/version `1`, atomic write/rename for `languages.yaml`, and atomic model staging/rename. A failed replacement leaves the old data and registry record intact; a missing nonbase removal returns `IMAGE_LANGUAGE_NOT_INSTALLED`.

```ts
const languages = requested.split('+');
for (const code of languages)
  if (!(await hasInstalledLanguage(pluginRoot, code))) {
    throw imageError(
      'IMAGE_LANGUAGE_NOT_INSTALLED',
      `Image language ${code} is not installed.`,
      `Run sheldon image language install ${code}.`,
    );
  }
const output = await run(
  executable,
  [temporaryImage, 'stdout', '--tessdata-dir', tessdata, '-l', requested],
  { shell: false },
);
```

- [x] **Step 4: Run focused plugin and package verification**

Run: `npm run build && npm test -- --run packages/plugins/official/source.image/test packages/plugins/official/source.file/test && npm run verify:plugin-contract`

Expected: PASS. Tests use fake executable/model fixtures; source image works with `por+eng`, honors only installed extras, and source file still declines images.

- [~] **Step 5: Commit the image plugin and local language ownership (pending prior Task 4 shared-file handoff)**

```bash
git add packages/plugins/official/source.image tsconfig.json vitest.config.ts scripts package.json package-lock.json
git commit -m "feat(source-image): embed OCR runtime and language registry"
```

### Task 6: Add image-language CLI commands and catalog-visible network source manifests

**Files:**

- Create: `apps/cli/src/commands/images.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/plugin-services.ts`
- Create: `apps/cli/test/images.test.ts`
- Create: `packages/plugins/official/source.url/{package.json,plugin.mjs,sheldon-plugin.json,sheldon-plugin.contract.json,src/index.ts,test/plugin.test.ts,THIRD_PARTY_NOTICES}`
- Create: `packages/plugins/official/source.youtube/{package.json,plugin.mjs,sheldon-plugin.json,sheldon-plugin.contract.json,src/index.ts,test/plugin.test.ts,THIRD_PARTY_NOTICES}`
- Modify: `tsconfig.json`, `vitest.config.ts`, `scripts/build.mjs`, `scripts/verify-plugin-contract.mjs`, root `package.json`, `package-lock.json`

**Interfaces:**

```ts
export async function listImageLanguageCommand(context: CommandContext): Promise<void>;
export async function installImageLanguageCommand(
  code: string,
  context: CommandContext,
): Promise<void>;
export async function removeImageLanguageCommand(
  code: string,
  context: CommandContext,
): Promise<void>;
```

- [ ] **Step 1: Write failing command and manifest tests**

```ts
it('lists base and extra source.image languages without fetching', async () => {
  const result = await runCli(['image', 'language', 'list'], installedImageDependencies);
  expect(result.stdout).toContain('por\tbase');
  expect(result.stdout).toContain('eng\tbase');
  expect(fetch.calls).toEqual([]);
});

it('installs only a signed source.image language and rejects noncatalog or base removal', async () => {
  await expect(
    runCli(['image', 'language', 'install', 'deu'], dependencies),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    runCli(['image', 'language', 'install', 'zzz'], dependencies),
  ).resolves.toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining('IMAGE_LANGUAGE_NOT_CATALOGED'),
  });
  await expect(runCli(['image', 'language', 'remove', 'eng'], dependencies)).resolves.toMatchObject(
    { exitCode: 1, stderr: expect.stringContaining('IMAGE_LANGUAGE_REQUIRED') },
  );
});

it.each(['source.url', 'source.youtube'])(
  'declares explicit network access only for user-initiated future ingest: %s',
  async (id) => {
    expect(await describeFixture(id)).toMatchObject({
      id,
      permissions: { network: true, cookies: false },
    });
  },
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run apps/cli/test/images.test.ts packages/plugins/official/source.url/test packages/plugins/official/source.youtube/test`

Expected: FAIL because the image command group and the two catalog-visible source manifests do not exist.

- [ ] **Step 3: Implement commands and minimal future-source protocol packages**

Add `sheldon image language list`, `install <code>`, and `remove <code>`. All commands first call `registry.getInstalled('source.image')`; no installation is inferred. `list` reads local data only. `install` loads and verifies the catalog, selects only `owner: 'source.image'` plus the current platform artifact, and delegates to `installImageLanguage`; it never accepts a URL/path. `remove` never fetches and delegates to the atomic registry function. Use the stable target `<source.image root>/data/tessdata` in diagnostics.

Create protocol-valid `source.url` and `source.youtube` packages so the official catalog can expose all four source plugin IDs. Their manifests declare `network: true`, `cookies: false`, their `healthcheck` is explicit about the pending source-specific milestone, and their `ingest` returns `SOURCE_NOT_IMPLEMENTED` without network activity. Do not add URL/YouTube ingestion behavior to this scope.

```ts
const image = program.command('image');
const language = image.command('language');
language.command('list').action(() => listImageLanguageCommand(context));
language
  .command('install <code>')
  .action((code: string) => installImageLanguageCommand(code, context));
language
  .command('remove <code>')
  .action((code: string) => removeImageLanguageCommand(code, context));
```

- [ ] **Step 4: Run command and contract regression tests**

Run: `npm run build && npm test -- --run apps/cli/test/images.test.ts apps/cli/test/official-catalog-cli.test.ts packages/plugins/official/source.url/test packages/plugins/official/source.youtube/test && npm run verify:plugin-contract`

Expected: PASS. Only the explicitly requested remote install calls catalog/artifact fetch; list/remove remain offline.

- [ ] **Step 5: Commit catalog-visible sources and image commands**

```bash
git add apps/cli packages/plugins/official/source.url packages/plugins/official/source.youtube tsconfig.json vitest.config.ts scripts package.json package-lock.json
git commit -m "feat(cli): manage source image languages"
```

### Task 7: Produce and verify signed cross-platform release assets

**Files:**

- Create: `release/official-catalog-public.pem`
- Create: `scripts/release/build-official-artifacts.mjs`
- Create: `scripts/release/sign-official-catalog.mjs`
- Create: `scripts/release/verify-official-release.mjs`
- Create: `scripts/release/test/{build-official-artifacts.test.ts,verify-official-release.test.ts,fixtures/**}`
- Create: `.github/workflows/release.yml`
- Modify: `package.json`, `scripts/build.mjs`, `scripts/build.test.ts`
- Modify: `scripts/verify-plugin-manifests.mjs`, `scripts/verify-plugin-contract.mjs`

**Interfaces:**

```ts
// build-official-artifacts.mjs CLI
// node scripts/release/build-official-artifacts.mjs --input release/stage --output release/out --published-at 2026-07-21T00:00:00.000Z
// node scripts/release/sign-official-catalog.mjs --catalog release/out/catalog.json --signature release/out/catalog.sig
// node scripts/release/verify-official-release.mjs --directory release/out --public-key release/official-catalog-public.pem
```

- [ ] **Step 1: Write failing release-artifact tests**

```ts
it('builds one deterministic ZIP per supported platform, catalog record, SBOM, and notices', async () => {
  await buildOfficialArtifacts(fixtureInput, fixtureOutput, fixedClock);
  expect(await listArchiveNames(fixtureOutput)).toEqual([
    'source.file-win32-x64.zip',
    'source.image-win32-x64.zip',
    'source.url-win32-x64.zip',
    'source.youtube-win32-x64.zip',
  ]);
  expect(await readFile(join(fixtureOutput, 'catalog.json'), 'utf8')).toContain(
    '"schemaVersion": 1',
  );
  await expect(access(join(fixtureOutput, 'SBOM.spdx.json'))).resolves.toBeUndefined();
  await expect(access(join(fixtureOutput, 'THIRD_PARTY_NOTICES'))).resolves.toBeUndefined();
});

it('rejects an archive without notices, a source.image package without packaged tessdata, or a mismatched manifest digest', async () => {
  await expect(verifyOfficialRelease(brokenRelease, publicKey)).rejects.toThrow(
    'OFFICIAL_RELEASE_IMAGE_RUNTIME_MISSING',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run scripts/release/test/build-official-artifacts.test.ts scripts/release/test/verify-official-release.test.ts`

Expected: FAIL because release builders and verifiers do not exist.

- [ ] **Step 3: Implement deterministic build, signing, and release verification**

Have the builder stage `source.file`, `source.image`, `source.url`, and `source.youtube` separately for each `win32-x64`, `darwin-arm64`, `darwin-x64`, and `linux-x64` archive. Enforce a package manifest matching its ID/version/platform and use archive entries with normalized POSIX paths and a fixed timestamp from `--published-at`. For `source.image`, require its executable/runtime libraries, `data/tessdata/por.traineddata`, `data/tessdata/eng.traineddata`, and notices before archive creation. Emit SHA-256/byte records pointing to the exact GitHub Release download URL convention, then emit a sorted schema-v1 catalog, SPDX JSON SBOM, and combined notices.

The signer reads `SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM` only from CI process environment, signs catalog bytes using Ed25519, writes only `catalog.sig`, and errors if the variable is absent. It must not log, serialize, or copy the key. Commit only the paired public PEM, and compile/load it through the CLI catalog factory. The verifier repeats catalog signature/schema checks, archive safe-extraction, manifest digest/package checks, and source.image packaged `--tessdata-dir` launch against a fake runtime fixture for every platform archive.

```js
const privateKey = process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
if (!privateKey)
  throw new Error('SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM is required in release CI.');
await writeFile(
  signaturePath,
  sign(null, await readFile(catalogPath), createPrivateKey(privateKey)),
);
```

- [ ] **Step 4: Run release and repository verification**

Run: `npm test -- --run scripts/release/test && npm run build && node scripts/release/verify-official-release.mjs --directory scripts/release/test/fixtures/release-out --public-key release/official-catalog-public.pem && npm run verify`

Expected: PASS. The CI workflow builds artifacts on each supported platform, runs the verifier before upload, signs only through the configured GitHub secret, and uploads no private key.

- [ ] **Step 5: Commit release reproducibility and verification**

```bash
git add release scripts/release .github/workflows/release.yml package.json scripts/build.mjs scripts/build.test.ts scripts/verify-plugin-manifests.mjs scripts/verify-plugin-contract.mjs
git commit -m "build(release): publish signed official plugin catalog"
```

### Task 8: Update product documentation and run the complete quality gate

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/roadmap.md`
- Modify: `packages/ingestion/README.md`
- Modify: `docs/product/architecture.md`
- Modify: `docs/superpowers/specs/2026-07-21-official-catalog-and-image-ocr-design.md` only if implementation exposes a necessary approved wording correction
- Modify: `apps/cli/test/{official-catalog-cli.test.ts,images.test.ts,file-ingestion-acceptance.test.ts}`

**Interfaces:** Documentation must show the exact public commands:

```powershell
sheldon plugin list
sheldon plugin list --remote
sheldon plugin info source.image --remote
sheldon plugin install source.file
sheldon plugin install source.image
sheldon image language list
sheldon image language install deu
sheldon image language remove deu
```

- [ ] **Step 1: Write failing documentation-facing acceptance assertions**

```ts
it('reports the image-language remediation before launching OCR and never mentions a visible OCR plugin', async () => {
  const result = await runCli(['image', 'language', 'remove', 'por'], dependencies);
  expect(result.stderr).toContain('IMAGE_LANGUAGE_REQUIRED');
  expect(await readFile('README.md', 'utf8')).resolves.not.toContain('ocr.tesseract');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run apps/cli/test/images.test.ts apps/cli/test/official-catalog-cli.test.ts`

Expected: FAIL until the public wording and command examples match the finished CLI behavior.

- [ ] **Step 3: Document the completed trust and ownership model**

Replace references to bundled `sheldon.file` and system-installed Tesseract with optional catalog installation and `source.file`/`source.image` ownership. Explain that a remote list/info/install verifies the catalog signature and release artifact hash/size; a local list or language list/remove does not use the network. State the packaged `por+eng` default, extra-language lifecycle, immutable base models, diagnostics, platform support, release SBOM/notices, and that no `ocr.tesseract` plugin exists. Keep the trusted raw publisher description and M2 continuity intact. Add an Unreleased changelog entry and update roadmap status only for this completed distribution/OCR scope, not URL/YouTube ingestion functionality.

- [ ] **Step 4: Run the complete quality gate and inspect the final diff**

Run: `npm run verify && git diff --check && git status --short`

Expected: PASS for format, lint, typecheck, Markdown lint, tests, coverage, build, plugin contracts, domain/repository checks, release verification, and whitespace. The only remaining changes are this scope and intentional handoff artifacts.

- [ ] **Step 5: Commit documentation and acceptance coverage**

```bash
git add README.md CHANGELOG.md docs/roadmap.md docs/product/architecture.md packages/ingestion/README.md apps/cli/test
git commit -m "docs(plugins): document official catalog and image OCR"
```

## Plan Self-Review

| Approved design requirement                                                 | Plan tasks |
| --------------------------------------------------------------------------- | ---------- |
| Optional local-only vs explicit remote catalog UX                           | 1, 3, 8    |
| Ed25519 catalog, schema, release-host, hash, count, and platform validation | 1, 2, 7    |
| Atomic registry installation with no execution/overwrite                    | 2, 3       |
| Split document and image source ownership                                   | 4, 5       |
| Packaged runtime/base models and `por+eng` OCR                              | 5, 7, 8    |
| Explicit additional language lifecycle and immutable bases                  | 5, 6, 8    |
| Network declaration and catalog-visible source plugins                      | 4, 5, 6, 7 |
| Release artifacts, SBOM, notices, and private-key isolation                 | 7          |
| Offline injected tests and M2/raw compatibility                             | 1–8        |

Self-review completed: all approved requirements map to a task; task interfaces use the same names and types across boundaries; and no step relies on an arbitrary remote URL, a system Tesseract mutation, or a visible OCR plugin.
