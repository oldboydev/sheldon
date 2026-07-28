# Source URL Single-Page Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Every task needs a fresh implementer and a read-only review gate.

**Goal:** Deliver `sheldon ingest url <kind> <slug> <url>` that safely ingests one public HTML/text page through the official `source.url` plugin and publishes an original response plus normalized Markdown as a new content-addressed source revision.

**Architecture:** The `source.url` package owns a testable URL resolver/transport boundary that validates every redirect target and pins the validated address for the actual connection. The plugin turns the bounded response into host-validated artifacts. The CLI gains a URL-specific command and a minimal generalization of the existing publisher: source identity stays content-addressed, while the canonical URL is preserved as provenance and can legitimately receive new revisions when its content changes.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Node `http`/`https`/`dns`, Turndown, Commander, existing plugin host/SDK and ingestion publisher.

## Global Constraints

- Implement exactly one page per invocation. Do not crawl, follow document links, ingest sitemaps, implement YouTube, authenticate, send cookies, bypass paywalls/DRM, or use paid APIs.
- Accept only absolute `http:`/`https:` URLs without credentials or fragments; reject every plugin option.
- Validate the initial URL and every redirect target. Cap redirects at 5 and response bytes at 5 MiB while streaming.
- Reject loopback, unspecified, private, link-local, multicast, IPv6 local, and IPv6 unique-local addresses. The actual transport must connect only to an address returned by the validated resolver and preserve HTTPS certificate verification/SNI.
- Accept only HTML/XHTML, `text/plain`, and `text/markdown`; use deterministic Markdown normalization and redact query/fragment values in diagnostics.
- Preserve the content-addressed source ID/revision model. A changed response at the same canonical URL produces a new source revision; do not deduplicate solely by URL.
- Keep `source.file` behavior unchanged. `source.youtube` stays a scaffold. Do not touch OCR/native watchdog files or `.superpowers/sdd/task-4-report.md`.
- No release, signing, tag, catalog-version change, or external network test.

---

### Task 1: Build the safe request boundary

**Files:**

- Create: `packages/plugins/official/source.url/src/request.ts`
- Create: `packages/plugins/official/source.url/test/request.test.ts`
- Modify: `packages/plugins/official/source.url/package.json`

**Interfaces:**

```ts
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export interface UrlResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}
export interface UrlTransport {
  request(input: {
    readonly url: URL;
    readonly hostname: string;
    readonly address: ResolvedAddress;
    readonly signal: AbortSignal;
  }): Promise<UrlResponse>;
}
export interface UrlRequestDependencies {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly transport?: UrlTransport;
}
export interface FetchedUrl {
  readonly canonicalUri: string;
  readonly responseUri: string;
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown';
  readonly bytes: Uint8Array;
}
export async function fetchPublicUrl(
  value: string,
  dependencies?: UrlRequestDependencies,
): Promise<FetchedUrl>;
```

- [ ] **Step 1: Write failing URL-policy tests**

Use fake resolver/transport objects so no test opens a socket. Cover each error code and assert messages contain only an origin/path with query and fragment redacted:

```ts
await expect(fetchPublicUrl('file:///secret')).rejects.toThrow('URL_INPUT_INVALID');
await expect(fetchPublicUrl('https://user:pass@example.test')).rejects.toThrow('URL_INPUT_INVALID');
await expect(fetchPublicUrl('https://example.test/#token')).rejects.toThrow('URL_INPUT_INVALID');
await expect(
  fetchPublicUrl('https://localhost.test', {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
  }),
).rejects.toThrow('URL_ADDRESS_FORBIDDEN');
```

Add table-driven forbidden-address cases for `0.0.0.0`, RFC1918 IPv4 ranges, `169.254.0.1`, `224.0.0.1`, `::`, `::1`, `fe80::1`, `fc00::1`, and `ff00::1`. Assert a permitted resolver result is passed unchanged as `input.address` to the transport.

Add tests for: redirect target revalidation, 6th redirect (`URL_REDIRECT_LIMIT`), redirect without valid Location (`URL_REDIRECT_INVALID`), a 5 MiB plus one-byte streamed body (`URL_RESPONSE_TOO_LARGE`), unsupported/missing content type (`URL_CONTENT_TYPE_UNSUPPORTED`), and valid HTML/plain/Markdown response collection.

- [ ] **Step 2: Run RED**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts
```

Expected: FAIL because `request.ts` and `fetchPublicUrl` do not exist.

- [ ] **Step 3: Implement canonicalization, address policy, and pinned transport**

Implement `fetchPublicUrl` as the only request loop. Construct `new URL(value)`, reject non-HTTP(S), credentials, fragment, non-default explicit ports, and malformed hosts. Canonical URI is `url.href` after clearing the fragment.

Use `dns.promises.lookup(hostname, { all: true, verbatim: true })` in the production resolver. Require at least one address and reject the entire hostname if any returned address is forbidden. Implement `isPublicAddress` with `node:net.isIP` plus explicit IPv4/IPv6 range checks; never infer safety from a hostname string.

Implement production `UrlTransport` with `http.request`/`https.request`, an agent/lookup callback that returns the validated address only, `Host: hostname`, and HTTPS `servername: hostname`. Do not set `rejectUnauthorized: false`. Stream chunks, abort on 5 MiB plus one byte, and return lowercase headers. Resolve relative redirects against the current URL, then repeat validation/resolution before the next connection.

Map failures with `urlError(code, safeTarget, message)` using codes `URL_INPUT_INVALID`, `URL_ADDRESS_FORBIDDEN`, `URL_REDIRECT_INVALID`, `URL_REDIRECT_LIMIT`, `URL_RESPONSE_TOO_LARGE`, `URL_CONTENT_TYPE_UNSUPPORTED`, and `URL_RESPONSE_UNREADABLE`.

- [ ] **Step 4: Verify GREEN**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts
npx prettier --check packages/plugins/official/source.url/src/request.ts packages/plugins/official/source.url/test/request.test.ts
git diff --check
```

Expected: every test passes, and no test depends on external DNS/network.

- [ ] **Step 5: Commit**

```powershell
git add packages/plugins/official/source.url/src/request.ts packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/package.json package-lock.json
git commit -m "feat(url): add bounded public request policy"
```

**Review gate:** Reject a transport that re-resolves at connection time, permits any blocked address family, buffers an unlimited body, follows an unvalidated redirect, exposes query values in errors, or calls a real site in tests.

---

### Task 2: Materialize safe URL artifacts in the official plugin

**Files:**

- Create: `packages/plugins/official/source.url/src/normalize.ts`
- Create: `packages/plugins/official/source.url/src/plugin.ts`
- Modify: `packages/plugins/official/source.url/src/index.ts`
- Modify: `packages/plugins/official/source.url/test/plugin.test.ts`
- Modify: `packages/plugins/official/source.url/package.json`

**Interfaces:**

```ts
export function normalizeUrlContent(input: {
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown';
  readonly bytes: Uint8Array;
}): {
  readonly content: string;
  readonly format: 'html' | 'text' | 'markdown';
  readonly status: 'complete' | 'gap';
  readonly warnings: readonly string[];
};

export interface OfficialSourceUrlDependencies extends UrlRequestDependencies {
  readonly fetchPublicUrl?: typeof fetchPublicUrl;
}
export function createOfficialSourceUrlPlugin(
  dependencies?: OfficialSourceUrlDependencies,
): PluginImplementation;
```

- [ ] **Step 1: Write failing normalizer and plugin tests**

Use a fake `fetchPublicUrl` returning fixed bytes. Require `probe({ input: { url } })` to claim only valid HTTP(S) URLs, while invalid input is unsupported. Require ingest to reject every option and invalid/missing `input.url` with `URL_INPUT_INVALID`.

For HTML fixture `<title>Example</title><script>bad()</script><article><h1>Hello</h1><p>World</p></article>`, assert normalized Markdown contains `# Hello` and `World` but not `bad()`. For plain text and Markdown assert newline normalization. For invalid UTF-8/empty usable output assert a deterministic `gap` warning rather than binary output.

Assert returned artifacts are exactly original `original.html|txt|md` and normalized `content.md`, have actual SHA-256/byte fields, and normalized metadata equals:

```ts
{
  canonicalUri: 'https://example.test/article',
  extractor: 'source-url',
  format: 'html',
  extractionStatus: 'complete',
  warnings: [],
}
```

- [ ] **Step 2: Run RED**

```powershell
npm test -- packages/plugins/official/source.url/test/plugin.test.ts
```

Expected: FAIL because the URL plugin still throws `SOURCE_NOT_IMPLEMENTED`.

- [ ] **Step 3: Implement deterministic normalization and artifact creation**

Declare `turndown` and `@types/turndown` directly in `source.url/package.json`. In `normalize.ts`, configure the same deterministic Turndown options used by source.file, remove `script`, `style`, `template`, `noscript`, and comments before conversion, and normalize line endings/trailing whitespace. Decode only UTF-8 with `TextDecoder('utf-8', { fatal: true })`; on decode/conversion degradation return `status: 'gap'` and an explicit warning.

In `plugin.ts`, validate exactly `{ url: string }`, reject all options, call `fetchPublicUrl`, materialize the source bytes and Markdown in `request.temporaryDirectory`, and compute artifact IDs/bytes/SHA-256 from written files. Map request and materialization errors to stable URL error codes; do not replace them with `SOURCE_NOT_IMPLEMENTED`.

Update `index.ts` to export `createOfficialSourceUrlPlugin`, `runOfficialSourceUrlPlugin`, and the dependency type.

- [ ] **Step 4: Verify GREEN**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/test/plugin.test.ts
npm run typecheck
npx prettier --check packages/plugins/official/source.url/src packages/plugins/official/source.url/test packages/plugins/official/source.url/package.json
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add packages/plugins/official/source.url/src packages/plugins/official/source.url/test packages/plugins/official/source.url/package.json package-lock.json
git commit -m "feat(url): ingest one public page"
```

**Review gate:** Reject browser/global fetch use, cookies/auth headers, a binary fallback, nondeterministic Markdown, missing artifact hashes, a URL option silently ignored, or a regression in source.file.

---

### Task 3: Add URL contract and host diagnostic mapping

**Files:**

- Add: `packages/plugins/official/source.url/sheldon-plugin.contract.json`
- Modify: `scripts/verify-plugin-contract.mjs`
- Modify: `packages/plugin-host/src/process-runner.ts`
- Add: `packages/plugin-host/test/process-runner-url-diagnostics.test.ts`
- Modify: `packages/plugins/official/source.url/test/plugin.test.ts`

**Interfaces:**

- `source.url` contract declares `ingest-url`, `network: true`, `cookies: false`, and uses only a deterministic invalid URL probe/ingest case; it never causes a live request.
- `PluginProcessRunner` forwards all URL codes from the Task 1 set as `PluginHostError` without collapsing them into `PLUGIN_OPERATION_FAILED`.

- [ ] **Step 1: Write failing contract/diagnostic tests**

Add a process-runner fixture that emits each URL code and assert the runner returns that exact code. Add a verifier assertion that both `source.file` and `source.url` contracts execute successfully after build. Add URL-plugin test coverage that a contract-safe invalid input fails before `fetchPublicUrl` is called.

- [ ] **Step 2: Run RED**

```powershell
npm test -- packages/plugin-host/test/process-runner-url-diagnostics.test.ts packages/plugins/official/source.url/test/plugin.test.ts
npm run verify:plugin-contract
```

Expected: FAIL because URL codes are not classified and no source.url contract exists.

- [ ] **Step 3: Implement contract-safe verification**

Add `source.url` to the verifier's explicit plugin list. Create its contract fixture so the probe uses `file:` and the ingest uses `file:`; both must produce `URL_INPUT_INVALID` without opening a network connection. Replace `fileDiagnosticCodes` with `sourceDiagnosticCodes` containing existing file codes and every Task 1 URL code. Keep unknown plugin errors wrapped as before.

- [ ] **Step 4: Verify GREEN**

```powershell
npm run build
npm test -- packages/plugin-host/test/process-runner-url-diagnostics.test.ts packages/plugins/official/source.url/test/plugin.test.ts
npm run verify:plugin-contract
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add packages/plugins/official/source.url/sheldon-plugin.contract.json packages/plugins/official/source.url/test/plugin.test.ts scripts/verify-plugin-contract.mjs packages/plugin-host/src/process-runner.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts
git commit -m "test(url): enforce URL plugin contract"
```

**Review gate:** Reject a contract that contacts the network, a host that hides a URL policy error, or any weakening of existing file diagnostic forwarding.

---

### Task 4: Generalize source publication without changing revision semantics

**Files:**

- Modify: `packages/ingestion/src/plugin-file-ingestor.ts`
- Modify: `packages/ingestion/src/index.ts`
- Modify: `packages/ingestion/test/plugin-file-ingestor.test.ts`
- Modify: `apps/cli/src/commands/memory.ts`
- Modify: `apps/cli/test/memory.test.ts`

**Interfaces:**

```ts
export interface PublishPluginSourceInput {
  readonly rawDirectory: string;
  readonly plugin: { readonly id: string; readonly version: string };
  readonly originalName: string;
  readonly options?: Readonly<Record<string, IngestionOption>>;
}
export const publishPluginSourceIngestion: typeof publishPluginFileIngestion;
```

- [ ] **Step 1: Write failing publisher tests**

Refactor test fixtures to use `originalName`. Assert `source.file` still writes its source basename. Add a URL-shaped fixture with `originalName: 'example-test-article.html'`, canonical URI metadata, and two different original byte strings at the same URL; assert their source IDs differ and the later publication records revision linkage instead of overwriting/deduplicating by URL.

- [ ] **Step 2: Run RED**

```powershell
npm test -- packages/ingestion/test/plugin-file-ingestor.test.ts apps/cli/test/memory.test.ts
```

Expected: FAIL because publisher input still requires `filePath` and derives basename internally.

- [ ] **Step 3: Implement the minimal publisher generalization**

Rename the public interface/function to `PublishPluginSourceInput`/`publishPluginSourceIngestion`; export compatibility aliases for the old names so existing callers remain source-compatible. Validate `originalName` as one safe basename (no separators, dot-only value, or traversal). Replace only the original-name derivation in publication; retain original-byte-plus-options source ID computation and all existing lease/artifact/metadata validation.

Update `ingestFile` to pass `originalName: basename(sourcePath)`. Do not add URL code to this task yet.

- [ ] **Step 4: Verify GREEN**

```powershell
npm test -- packages/ingestion/test/plugin-file-ingestor.test.ts apps/cli/test/memory.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add packages/ingestion/src/plugin-file-ingestor.ts packages/ingestion/src/index.ts packages/ingestion/test/plugin-file-ingestor.test.ts apps/cli/src/commands/memory.ts apps/cli/test/memory.test.ts
git commit -m "refactor(ingestion): publish generic plugin sources"
```

**Review gate:** Reject URL-only dedupe, a source-ID algorithm change, unsafe original names, discarded normalized metadata, or any changed file-ingestion result.

---

### Task 5: Route URL ingestion through the CLI and verify end-to-end behavior

**Files:**

- Modify: `apps/cli/src/commands/memory.ts`
- Modify: `apps/cli/src/main.ts`
- Add: `apps/cli/test/url-ingestion-acceptance.test.ts`
- Modify: `apps/cli/test/main.test.ts`
- Modify: `README.md`

**Interfaces:**

```ts
export interface UrlIngestionOptions extends VaultOption {
  readonly plugin?: string;
}
export async function ingestUrl(
  kind: EntityKind,
  slug: string,
  value: string,
  options: UrlIngestionOptions,
  context: CommandContext,
): Promise<void>;
```

- [ ] **Step 1: Write failing CLI acceptance tests**

Using an installed fixture URL plugin that returns safe original/normalized artifacts, require:

```text
sheldon ingest url topic example https://example.test/article --vault <vault>
```

to select `ingest-url`, publish an original named from the plugin artifact, store canonical URL metadata, and print the publication JSON. Cover `--plugin`, ambiguous candidates, invalid `file:` URL, and a forwarded `URL_ADDRESS_FORBIDDEN` error with a redacted target. Add a same-URL/new-bytes test proving a new revision is retained.

- [ ] **Step 2: Run RED**

```powershell
npm test -- apps/cli/test/url-ingestion-acceptance.test.ts apps/cli/test/main.test.ts
```

Expected: FAIL because `ingest url` is not registered.

- [ ] **Step 3: Implement command routing**

In `memory.ts`, parse `new URL(value)` and require HTTP(S), no credentials, no fragment; form `input = { url: canonical.href }`, select `capability: 'ingest-url'`, and call `publishPluginSourceIngestion` with `originalName` read from the validated original artifact path. Never call `resolveReadableInput` for a URL.

In `main.ts`, add `ingest url <kind> <slug> <url>` with `--vault` and `--plugin`, wired to `ingestUrl`. Document the command, page-only behavior, and security limits in README; do not document crawl/YouTube as implemented.

- [ ] **Step 4: Verify end-to-end GREEN**

```powershell
npm test -- apps/cli/test/url-ingestion-acceptance.test.ts apps/cli/test/main.test.ts apps/cli/test/memory.test.ts packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/test/plugin.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts
npm run typecheck
npm run build
npm run verify:plugin-contract
npx prettier --check apps/cli/src/commands/memory.ts apps/cli/src/main.ts apps/cli/test/url-ingestion-acceptance.test.ts README.md
git diff --check
```

- [ ] **Step 5: Commit**

```powershell
git add apps/cli/src/commands/memory.ts apps/cli/src/main.ts apps/cli/test/url-ingestion-acceptance.test.ts apps/cli/test/main.test.ts README.md
git commit -m "feat(cli): ingest one public URL"
```

**Review gate:** Reject CLI code that resolves a URL as a filesystem path, makes a network request itself, loses canonical provenance, permits crawl options, swallows host URL errors, or changes YouTube behavior.

---

### Task 6: Run the bounded local release checks

**Files:**

- No source changes expected.

- [ ] **Step 1: Run focused functionality and security suites**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts apps/cli/test/url-ingestion-acceptance.test.ts apps/cli/test/memory.test.ts apps/cli/test/main.test.ts scripts/release/test/build-official-artifacts.test.ts scripts/release/test/stage-official-artifacts.test.ts
npm run typecheck
npm run build
npm run verify:plugin-contract
npm run lint
git diff --check
```

Expected: all local checks pass with zero external HTTP requests.

- [ ] **Step 2: Build local official artifacts only if every package input is already available**

```powershell
node scripts/release/stage-official-artifacts.mjs --source packages/plugins/official --output release/url-stage
node scripts/release/build-official-artifacts.mjs --input release/url-stage --output release/url-artifacts --published-at 2026-07-24T00:00:00.000Z
```

Expected: source.url artifact exists for every official platform. Do not sign, publish, tag, upload, edit a catalog version, or invoke OCR/native workflows.

- [ ] **Step 3: Record validation result**

Add a concise execution note to the implementation report identifying every command run and any unavailable artifact prerequisite. Do not change user-owned `.superpowers/sdd/task-4-report.md`.

**Review gate:** Reject completion on a live external fetch, absent URL contract, a release-side-effect command, or a regression in source.file tests.
