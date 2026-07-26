# Source URL Bounded Crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, deterministic, bounded public-site crawling through `sheldon ingest crawl` and the official `source.url` plugin without changing single-page URL or YouTube behavior.

**Architecture:** Extend the existing SSRF-safe request module with opt-in deadline/header/redirect/budget controls, then compose pure link and robots policy modules in a sequential BFS crawler. `source.url` emits one deterministic crawl bundle, combined Markdown, and inventory asset; the new CLI command selects `ingest-site` and publishes that bundle through the unchanged generic source publisher.

**Tech Stack:** Node.js 24, TypeScript 6, Vitest 4, Node `http`/`https`/`dns`, `@mixmark-io/domino`, Turndown, Commander 15, existing plugin SDK/host and ingestion publisher.

## Global Constraints

- Expose exactly `sheldon ingest crawl <kind> <slug> <seed-url> --max-pages <1..10> --max-depth <0..2> [--vault <path>] [--plugin <id>]`; both numeric options are required strict unsigned decimal integers.
- Add `ingest-site` only to `source.url`. Keep `ingest url`, `ingest-url`, `source.youtube`, and URL `--language` behavior unchanged.
- Seed and every requested target use the existing pinned-address SSRF policy. Child and robots redirects must stay on the seed's effective exact origin and remain query-free.
- Use sequential deterministic BFS. Sort each next-depth frontier by JavaScript code-unit order; strip fragments; skip discovered queries; deduplicate requested and effective URLs.
- Fetch robots once only when a child is otherwise eligible. Apply `SheldonBot` rules; disallowed URLs are never requested; unreadable or ambiguous policy halts child traversal.
- Fixed limits: five redirects, 5,242,880 bytes per top-level fetch, 26,214,400 aggregate raw bytes, 15,000 milliseconds per fetch, 120,000 milliseconds total, and 1,000 globally new normalized discovered candidates after candidate/requested/effective dedupe.
- `maxPages` counts seed plus top-level child attempts, including child failures and effective redirect aliases. Redirect hops and robots do not consume page slots but do consume time and aggregate bytes.
- Send `User-Agent: SheldonBot/1.0`, the fixed HTML/text `Accept`, and `Accept-Encoding: identity`; send no referrer, cookies, authorization, caller headers, proxy, or credentials.
- Seed request failure and total timeout/cancellation are fatal with no publication. Record a child failure and continue lexical siblings unless a global raw/time limit stops traversal.
- Emit exactly one `original.crawl.json`, one `content.md`, and one `assets/crawl-inventory.json`. No headers or timestamps enter deterministic plugin artifacts.
- Extraction status becomes `gap` only for attempted page request/normalization failures, not for scope/query/robots/depth/page/candidate/dedupe skips.
- Preserve one-source atomic publisher semantics, content/options dedupe, and previous-revision linkage. Do not add per-page publication.
- No live external request in tests. Use injected resolver/transport/fetch functions or installed local fixture plugins.
- Do not modify README, roadmap, changelog, OCR/native runtime, release/signing/catalog files, `.superpowers/sdd/task-4-report.md`, or any other user task report.

## File map

| File                                                                                                                       | Responsibility                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/plugins/official/source.url/src/request.ts`                                                                      | Existing DNS, address, redirect, socket, streaming, and media-type safety boundary; gains opt-in crawl request controls.         |
| `packages/plugins/official/source.url/src/links.ts`                                                                        | Pure HTML `a[href]` extraction, resolution, fragment stripping, bounded known/new candidate policy, and malformed-href summary.  |
| `packages/plugins/official/source.url/src/robots.ts`                                                                       | Pure robots UTF-8 parser, user-agent group selection, wildcard/anchor rule matching, and ambiguity classification.               |
| `packages/plugins/official/source.url/src/crawl.ts`                                                                        | Total deadline, byte budget, robots fetch, sequential BFS, requested/effective dedupe, normalization, raw models, and inventory. |
| `packages/plugins/official/source.url/src/plugin.ts`                                                                       | Exact request dispatch, artifact serialization/materialization, metadata, hashes, and cancellation propagation.                  |
| `packages/plugins/official/source.url/src/index.ts`                                                                        | Public exports required by focused tests.                                                                                        |
| `packages/plugins/official/source.url/test/{request,links,robots,crawl,plugin}.test.ts`                                    | Unit and integration coverage with no external network.                                                                          |
| `packages/plugins/official/source.url/{package.json,THIRD_PARTY_NOTICES,sheldon-plugin.json,sheldon-plugin.contract.json}` | Declared parser dependency/license, capability, and contract-safe fixture.                                                       |
| `packages/plugin-host/src/process-runner.ts`                                                                               | Stable forwarding/redaction for new crawl diagnostics.                                                                           |
| `packages/plugin-host/test/process-runner-url-diagnostics.test.ts`                                                         | Host mapping regression coverage.                                                                                                |
| `apps/cli/src/commands/memory.ts`                                                                                          | `ingestCrawl`, `ingest-site` selection, exact plugin options, and generic publication.                                           |
| `apps/cli/src/main.ts`                                                                                                     | Strict numeric option parser and command registration.                                                                           |
| `apps/cli/test/crawl-ingestion-acceptance.test.ts`                                                                         | Installed-plugin end-to-end publication, dedupe, revision, and isolation coverage.                                               |
| `apps/cli/test/{main,url-ingestion-acceptance}.test.ts`                                                                    | Help/validation and unchanged URL/YouTube behavior.                                                                              |

`packages/ingestion/src/plugin-file-ingestor.ts` is intentionally absent: it
already accepts one original, one normalized artifact, and any validated asset
below `assets/`.

---

### Task 1: Add opt-in crawl controls to the safe request boundary

**Files:**

- Modify: `packages/plugins/official/source.url/src/request.ts`
- Modify: `packages/plugins/official/source.url/test/request.test.ts`

**Interfaces:**

- Consumes: existing `ResolvedAddress`, `UrlResponse`, resolver validation,
  pinned `UrlTransport`, redirect limit, media-type checks, and 5 MiB streamed
  body limit.
- Produces:

```ts
export interface UrlTransport {
  request(input: {
    readonly url: URL;
    readonly hostname: string;
    readonly address: ResolvedAddress;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<UrlResponse>;
}

export interface UrlRequestDependencies {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly transport?: UrlTransport;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export interface UrlFetchPolicy {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowRedirect?: (target: URL) => boolean;
  readonly consumeBytes?: (bytes: number) => boolean;
}

export interface FetchedUrl {
  readonly canonicalUri: string;
  readonly responseUri: string;
  readonly status: number;
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown';
  readonly bytes: Uint8Array;
}

export async function fetchPublicUrl(
  value: string,
  dependencies?: UrlRequestDependencies,
  policy?: UrlFetchPolicy,
): Promise<FetchedUrl>;
```

`consumeBytes` returns `false` before accepting a chunk that would cross the
caller's aggregate limit. The request layer then throws
`CRAWL_RAW_BUDGET_EXCEEDED`. `allowRedirect` runs after parsing the `Location`
and before DNS or transport; `false` throws `URL_REDIRECT_OUT_OF_SCOPE`.

- [ ] **Step 1: Write failing status, header, and redirect-policy tests**

Extend the fake transport request log to retain `headers` and `signal`. Add
these exact assertions:

```ts
const test = dependencies([response(302, 'text/html', [], { location: '/outside?query=1' })]);
const allowRedirect = vi.fn(() => false);

await expect(
  fetchPublicUrl('https://example.test/start', test.dependencies, {
    headers: {
      accept: 'text/html',
      'accept-encoding': 'identity',
      'user-agent': 'SheldonBot/1.0',
    },
    allowRedirect,
  }),
).rejects.toThrow('URL_REDIRECT_OUT_OF_SCOPE');

expect(allowRedirect).toHaveBeenCalledWith(new URL('https://example.test/outside?query=1'));
expect(test.requests).toHaveLength(1);
```

Add a 201 response assertion that `FetchedUrl.status === 201`. Assert the
transport receives exactly lower-case caller headers plus the internally owned
`host`, and does not receive `referer`, `cookie`, or `authorization`.

- [ ] **Step 2: Write failing deadline, cancellation, and byte-consumer tests**

Use an injected `timeoutSignal` that returns a retained controller signal.
Start a transport promise that settles only when its signal aborts. Abort the
timeout controller and require `URL_REQUEST_TIMEOUT`. Repeat with an external
controller supplied as `policy.signal`; abort it and assert the identical
signal reaches the transport without being remapped to a URL timeout.

For streamed chunks `[3 bytes, 3 bytes]`, use:

```ts
let remaining = 5;
const consumeBytes = (bytes: number): boolean => {
  if (bytes > remaining) return false;
  remaining -= bytes;
  return true;
};
```

Require `CRAWL_RAW_BUDGET_EXCEEDED`, `remaining === 2`, and no accepted second
chunk. Retain the existing 5 MiB plus one-byte
`URL_RESPONSE_TOO_LARGE` assertion.

- [ ] **Step 3: Run RED**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts
```

Expected: FAIL because `FetchedUrl` has no status, transport inputs have no
headers, and `fetchPublicUrl` has no crawl policy argument.

- [ ] **Step 4: Implement composed abort and opt-in policy**

Keep the current validation and address tables byte-for-byte unless a test
requires a type-only adaptation. Build one fetch-level signal from the
external signal and optional
`dependencies.timeoutSignal?.(timeoutMilliseconds) ??
AbortSignal.timeout(timeoutMilliseconds)`. The 15-second timer covers all
redirect hops and the final body of one top-level call.

Before each resolve, transport call, and body chunk, check the composed signal.
Preserve external cancellation so the plugin runner can emit
`PLUGIN_CANCELLED`; map only the dedicated timeout signal to
`URL_REQUEST_TIMEOUT`.

Pass a frozen lower-case header record to the transport. In
`productionTransport`, construct Node headers as `{ host: url.host,
...headers }` after rejecting any caller key outside `accept`,
`accept-encoding`, and `user-agent`. Keep `agent: false`, the pinned lookup
callback, certificate verification, and SNI.

Run `allowRedirect` before resolving a redirect target. In `collectBody`, apply
the per-response limit first and `consumeBytes` second, before retaining the
chunk. Return `status: response.status`.

- [ ] **Step 5: Run GREEN and regression checks**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/test/plugin.test.ts
npm run typecheck
npx prettier --check packages/plugins/official/source.url/src/request.ts packages/plugins/official/source.url/test/request.test.ts
git diff --check
```

Expected: all request and existing single-page plugin tests PASS; no test opens
external DNS or HTTP.

- [ ] **Step 6: Commit**

```powershell
git add packages/plugins/official/source.url/src/request.ts packages/plugins/official/source.url/test/request.test.ts
git commit -m "feat(url): bound crawl requests"
```

**Review gate:** Reject any fresh DNS lookup at connect time, timeout scoped to
only one redirect hop, swallowed external cancellation, unbounded redirect
body read, caller-controlled security header, or change to default
single-page headers/behavior.

---

### Task 2: Implement deterministic link discovery and robots policy

**Files:**

- Create: `packages/plugins/official/source.url/src/links.ts`
- Create: `packages/plugins/official/source.url/src/robots.ts`
- Create: `packages/plugins/official/source.url/test/links.test.ts`
- Create: `packages/plugins/official/source.url/test/robots.test.ts`
- Modify: `packages/plugins/official/source.url/package.json`
- Modify: `packages/plugins/official/source.url/THIRD_PARTY_NOTICES`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: HTML bytes and an already validated effective page URL; no network
  or filesystem.
- Produces:

```ts
export interface DiscoveredLink {
  readonly uri: string;
  readonly hasQuery: boolean;
}

export interface LinkDiscovery {
  readonly links: readonly DiscoveredLink[];
  readonly malformedHrefCount: number;
  readonly truncated: boolean;
  readonly warning?: 'URL_CONTENT_UTF8_INVALID';
}

export interface LinkDiscoveryInput {
  readonly bytes: Uint8Array;
  readonly effectiveUri: string;
  readonly knownUris: ReadonlySet<string>;
  readonly maximumNewCandidates: number;
}

export function discoverHtmlLinks(input: LinkDiscoveryInput): LinkDiscovery;

export type RobotsParseResult =
  | {
      readonly status: 'rules';
      allows(pathname: string): boolean;
    }
  | {
      readonly status: 'ambiguous';
      readonly warning: 'ROBOTS_POLICY_AMBIGUOUS';
    }
  | {
      readonly status: 'unreadable';
      readonly warning: 'ROBOTS_UTF8_INVALID';
    };

export function parseRobotsPolicy(bytes: Uint8Array, productToken: 'SheldonBot'): RobotsParseResult;
```

- [ ] **Step 1: Write failing link extraction tests**

Use HTML containing relative, absolute, fragment-only, empty-href,
off-origin, `mailto:`, `javascript:`, credential-bearing, query-bearing, image,
form, iframe, and meta-refresh values. Assert:

```ts
expect(
  discoverHtmlLinks({
    bytes: encoder.encode(`
      <base href="https://ignored.test/">
      <a href="/b#fragment">B</a>
      <a href="/a">A</a>
      <a href="/b">B again</a>
      <a href="/query?">Empty query</a>
      <form action="/form"></form>
      <meta http-equiv="refresh" content="0; url=/refresh">
    `),
    effectiveUri: 'https://example.test/root/page',
    knownUris: new Set(),
    maximumNewCandidates: 1_000,
  }),
).toEqual({
  links: [
    { uri: 'https://example.test/a', hasQuery: false },
    { uri: 'https://example.test/b', hasQuery: false },
    { uri: 'https://example.test/query?', hasQuery: true },
  ],
  malformedHrefCount: 0,
  truncated: false,
});
```

Require JavaScript code-unit sorting, fragment stripping before dedupe, ignored
`<base>`, no non-anchor discovery, and strict UTF-8 failure represented by
`links: []` and `warning: 'URL_CONTENT_UTF8_INVALID'`. A malformed URL-valued
href increments `malformedHrefCount` without copying the unsafe value.

Generate 1,001 distinct normalized anchor targets. Require exactly 1,000
links, `truncated: true`, deterministic selection from document order, and no
1,001st URI. Also supply a bounded `knownUris` set before a globally new link
and require known matches not to consume `maximumNewCandidates`; retained
output is bounded by `knownUris.size + maximumNewCandidates`.

- [ ] **Step 2: Write failing robots parser/matcher tests**

Cover:

- exact `SheldonBot` groups preferred over `*`;
- multiple exact groups merged;
- field and product-token case insensitivity;
- longest `Allow`/`Disallow` match and `Allow` tie;
- `*` wildcard and terminal `$`;
- empty `Disallow`;
- comments and blank lines;
- percent-encoded pathname matching without query input;
- ignored `Sitemap` and unknown non-control fields;
- invalid UTF-8 as `unreadable`;
- malformed applicable group/rule and applicable `Crawl-delay` as
  `ambiguous`.

Use exact examples:

```ts
const policy = parseRobotsPolicy(
  encoder.encode(`
    User-agent: *
    Disallow: /

    User-agent: SheldonBot
    Disallow: /private/*
    Allow: /private/public$
  `),
  'SheldonBot',
);

expect(policy.status).toBe('rules');
if (policy.status === 'rules') {
  expect(policy.allows('/private/a')).toBe(false);
  expect(policy.allows('/private/public')).toBe(true);
  expect(policy.allows('/about')).toBe(true);
}
```

- [ ] **Step 3: Run RED**

```powershell
npm test -- packages/plugins/official/source.url/test/links.test.ts packages/plugins/official/source.url/test/robots.test.ts
```

Expected: FAIL because neither pure policy module exists.

- [ ] **Step 4: Implement link parsing without regex HTML crawling**

Declare `"@mixmark-io/domino": "^2.2.0"` as a direct `source.url` dependency
and refresh only the lockfile records npm changes for that declaration. Add
the dependency's BSD-2-Clause name, version, repository, copyright notice, and
license text to `THIRD_PARTY_NOTICES`; retain the existing source.url notice
header.

Parse strict UTF-8 with `TextDecoder('utf-8', { fatal: true })`, then
`createDocument`. Iterate only `querySelectorAll('a[href]')`. Resolve each raw
attribute against the supplied effective URL, ignore the document's `<base>`,
strip `hash`, retain an explicit-query boolean before URL reserialization,
deduplicate by canonical `href`, and return code-unit-sorted links.

Do not copy malformed raw href values. Count them and expose one aggregate
signal. Treat `maximumNewCandidates` as the remaining crawler-global capacity:
known candidate/requested/effective URIs are retained for provenance without
being charged. Stop at the first globally new URI beyond that capacity, with
total retained output bounded by `knownUris.size + maximumNewCandidates`.

- [ ] **Step 5: Implement robots parsing and deterministic rule ranking**

Decode strict UTF-8 and normalize CRLF/CR to LF. Remove `#` comments, parse
colon-delimited fields, group consecutive `User-agent` lines with following
rules, and merge all groups for the selected exact product token or `*`
fallback.

Compile `*` as a path-character wildcard and a trailing `$` as end anchor.
Rank matching rules by the number of non-wildcard octets in the original
pattern; choose `Allow` on equal rank. Return `ambiguous` for malformed
applicable access directives or applicable `Crawl-delay`; ignore `Sitemap` and
unrecognized non-access directives.

- [ ] **Step 6: Run GREEN**

```powershell
npm test -- packages/plugins/official/source.url/test/links.test.ts packages/plugins/official/source.url/test/robots.test.ts
npm run typecheck
npx prettier --check packages/plugins/official/source.url/src/links.ts packages/plugins/official/source.url/src/robots.ts packages/plugins/official/source.url/test/links.test.ts packages/plugins/official/source.url/test/robots.test.ts packages/plugins/official/source.url/package.json
git diff --check
```

Expected: all pure policy tests PASS and no test starts a socket.

- [ ] **Step 7: Commit**

```powershell
git add packages/plugins/official/source.url/src/links.ts packages/plugins/official/source.url/src/robots.ts packages/plugins/official/source.url/test/links.test.ts packages/plugins/official/source.url/test/robots.test.ts packages/plugins/official/source.url/package.json packages/plugins/official/source.url/THIRD_PARTY_NOTICES package-lock.json
git commit -m "feat(url): define crawl discovery policy"
```

**Review gate:** Reject regex-only HTML extraction, `<base>` use, locale
sorting, a copied credential-bearing href, query loss before classification,
retention beyond `knownUris.size + maximumNewCandidates`, charging a known URI
as globally new, or permissive handling of ambiguous applicable robots rules.

---

### Task 3: Build the bounded sequential crawler

**Files:**

- Create: `packages/plugins/official/source.url/src/crawl.ts`
- Create: `packages/plugins/official/source.url/test/crawl.test.ts`
- Modify: `packages/plugins/official/source.url/src/index.ts`

**Interfaces:**

- Consumes:

```ts
fetchPublicUrl(
  value: string,
  dependencies?: UrlRequestDependencies,
  policy?: UrlFetchPolicy,
): Promise<FetchedUrl>;
discoverHtmlLinks(...): LinkDiscovery;
parseRobotsPolicy(bytes, 'SheldonBot'): RobotsParseResult;
normalizeUrlContent(...): NormalizedUrlContent;
```

- Produces:

```ts
export interface CrawlOptions {
  readonly maxDepth: 0 | 1 | 2;
  readonly maxPages: number;
}

export interface CrawlDependencies extends UrlRequestDependencies {
  readonly fetchPublicUrl?: typeof fetchPublicUrl;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export interface CrawlPage {
  readonly attempt: number;
  readonly depth: number;
  readonly requestedUri: string;
  readonly effectiveUri: string;
  readonly httpStatus: number;
  readonly mediaType: FetchedUrl['mediaType'];
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly extractionStatus: 'complete' | 'gap';
  readonly warnings: readonly string[];
  readonly markdown: string;
  readonly contributesContent: boolean;
}

export interface CrawlInventoryEntry {
  readonly sequence: number;
  readonly depth: number;
  readonly requestedUri?: string;
  readonly effectiveUri?: string;
  readonly target?: '[invalid href]' | '[candidate limit]';
  readonly status: 'visited' | 'failed' | 'skipped';
  readonly reason: string;
  readonly discoveredFrom: readonly string[];
}

export interface CrawlResult {
  readonly seedRequestedUri: string;
  readonly seedEffectiveUri: string;
  readonly scopeOrigin: string;
  readonly options: CrawlOptions;
  readonly robots: CrawlRobotsRecord;
  readonly pages: readonly CrawlPage[];
  readonly inventory: readonly CrawlInventoryEntry[];
  readonly extractionStatus: 'complete' | 'gap';
  readonly warnings: readonly string[];
}

export async function crawlPublicSite(
  seed: string,
  options: CrawlOptions,
  signal: AbortSignal,
  dependencies?: CrawlDependencies,
): Promise<CrawlResult>;
```

- [ ] **Step 1: Write failing option and seed boundary tests**

Require `crawlPublicSite` to reject every option object except integer
`maxPages` in `1..10` and integer `maxDepth` in `0..2` with
`CRAWL_INPUT_INVALID` before invoking the fake fetch.

Use a fake seed fetch returning a 302-resolved `FetchedUrl` whose
`canonicalUri` is `https://requested.test/start?q=explicit` and
`responseUri` is `https://effective.test/home`. Assert scope is
`https://effective.test`, the explicit seed query is retained, and links to
`requested.test` are outside scope.

Require a thrown seed request code and a seed `status: 500` to reject the whole
crawl. Require `maxDepth: 0` and `maxPages: 1` cases to call only the seed and
never `/robots.txt`.

- [ ] **Step 2: Write failing BFS, scope, query, and dedupe tests**

Create an injected fetch map:

```text
seed -> links /b, /a#one, /a#two, /query?x=1, https://other.test/x
/a   -> links /d, /c
/b   -> links /c
/c   -> content
/d   -> content
```

Return an absent robots response. Record `activeFetches` and `requestedUris`.
Require:

```text
https://example.test/start
https://example.test/robots.txt
https://example.test/a
https://example.test/b
https://example.test/c
https://example.test/d
```

with `activeFetches` never above 1. The page-attempt sequence excludes robots
and equals seed, `/a`, `/b`, `/c`, `/d`. `/a` is requested once despite two
fragment variants; `/c` is requested once despite two parents; query and
off-origin entries are skipped without a fetch.

Add two child requested URLs that resolve to the same effective URL. Require
both to consume page attempts and retain raw page records, while only the first
contributes Markdown/links and the second inventory reason is
`duplicate-effective`.

- [ ] **Step 3: Write failing robots integration tests**

Assert robots is fetched once immediately before the first child. Cover:

- 404 and 410 permit traversal;
- valid rules prevent a disallowed candidate from appearing in fetch calls;
- robots redirect off origin is not followed;
- 500, invalid UTF-8, applicable `Crawl-delay`, request timeout, unsupported
  media, and parse ambiguity mark robots unavailable and stop all child calls;
- robots request consumes aggregate bytes and total time but leaves the
  page-attempt number unchanged.

Require a robots halt alone to keep `extractionStatus: 'complete'`.

- [ ] **Step 4: Write failing strict-limit and failure tests**

Cover exact boundaries:

- 5 MiB per fetch through Task 1 behavior;
- aggregate consumer accepts byte 26,214,400 and rejects the next byte;
- the child that crosses aggregate budget records
  `CRAWL_RAW_BUDGET_EXCEEDED`, later children are
  `raw-budget-limit`/unattempted, and prior results remain;
- page attempt `maxPages` includes seed, failed children, and an effective
  duplicate;
- candidates at max depth become `depth-limit`;
- candidates left after attempts become `page-limit`;
- candidate 1,001 creates one `[candidate limit]` sentinel and no retained
  URI;
- known candidate/requested/effective URIs before a globally new link do not
  consume candidate capacity or hide that later link;
- child `URL_RESPONSE_UNREADABLE` records a failed attempt and the next lexical
  sibling runs;
- child invalid UTF-8 creates a gap marker and no child links;
- policy-only skips do not set `gap`, but child request/normalization failure
  does.

Pass an injected, already-composed operation signal. Its total timeout or
caller cancellation must reject the crawl, abort the in-flight fetch signal,
and not return a partial result. Task 4 owns creation of that signal at plugin
operation entry.

- [ ] **Step 5: Run RED**

```powershell
npm test -- packages/plugins/official/source.url/test/crawl.test.ts
```

Expected: FAIL because `crawl.ts` and its exports do not exist.

- [ ] **Step 6: Implement fixed limits and deterministic state**

Define these module constants exactly:

```ts
const CRAWL_USER_AGENT = 'SheldonBot/1.0';
const MAXIMUM_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_AGGREGATE_RAW_BYTES = 25 * 1024 * 1024;
const MAXIMUM_CANDIDATES = 1_000;
const PER_FETCH_TIMEOUT_MILLISECONDS = 15_000;
```

Accept the pre-composed operation signal from `plugin.ts`; do not create the
120-second deadline in `crawl.ts`. Maintain:

- `pageAttempts`, starting with seed;
- `remainingRawBytes`;
- `requestedUris` seeded with the canonical seed;
- `effectiveUris` populated after successful fetches;
- one frontier map per depth keyed by canonical requested URI;
- deterministic page and inventory arrays.

Use only `for ... of` with an awaited fetch. Never use `Promise.all` for
resolver, robots, or page work. Merge `discoveredFrom` sets, materialize them
in code-unit order, and sort the next frontier with the explicit comparator.

After the seed, derive `scopeOrigin` from `responseUri`. Child
`allowRedirect` requires exact origin and `!target.href.includes('?')`. Apply
the same predicate to robots. Use fixed crawl headers on all crawl fetches.

- [ ] **Step 7: Implement failure, robots, and extraction semantics**

Fetch robots only when a child is eligible and a page slot remains. Classify
404/410 as absent, 2xx `text/plain` through `parseRobotsPolicy`, and every
other result as unavailable/ambiguous. Stop traversal when robots is not
definitively absent or applicable.

For each child, charge a page attempt before the fetch. Preserve stable URL
diagnostic codes in inventory. Continue siblings after local request/HTTP
failure; stop after aggregate exhaustion and classify untouched known siblings
as `raw-budget-limit`. Reserve `page-limit` for exhaustion of `maxPages`.
Treat total timeout/cancellation as fatal.

Normalize every received page body through `normalizeUrlContent`. A unique
effective page contributes content; an effective duplicate does not.
Normalization warnings and request-failure codes determine combined gap
status exactly as Requirement R8 specifies.

Export only the crawler/types needed by tests and `plugin.ts`.

- [ ] **Step 8: Run GREEN**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/test/links.test.ts packages/plugins/official/source.url/test/robots.test.ts packages/plugins/official/source.url/test/crawl.test.ts
npm run typecheck
npx prettier --check packages/plugins/official/source.url/src/crawl.ts packages/plugins/official/source.url/src/index.ts packages/plugins/official/source.url/test/crawl.test.ts
git diff --check
```

Expected: all request/policy/crawl tests PASS; observed fetch concurrency is
exactly one.

- [ ] **Step 9: Commit**

```powershell
git add packages/plugins/official/source.url/src/crawl.ts packages/plugins/official/source.url/src/index.ts packages/plugins/official/source.url/test/crawl.test.ts
git commit -m "feat(url): crawl bounded site frontiers"
```

**Review gate:** Reject an origin anchored before seed redirects, robots after
the first child, query-bearing child redirect, locale-dependent order,
`Promise.all` network work, page slots that ignore failures/aliases, raw bytes
charged only after success, or partial return on cancellation/total timeout.

---

### Task 4: Materialize the atomic crawl bundle

**Files:**

- Modify: `packages/plugins/official/source.url/src/plugin.ts`
- Modify: `packages/plugins/official/source.url/src/index.ts`
- Modify: `packages/plugins/official/source.url/test/plugin.test.ts`

**Interfaces:**

- Consumes: `crawlPublicSite(seed, options, operationSignal, dependencies)`,
  existing single-page `normalizeUrlContent`, existing artifact writer/hash
  conventions, and the exact artifact schemas in the design. The plugin owns a
  test-injectable 120-second deadline-signal factory and composes that deadline
  with `context.signal` once, at `ingest-site` operation entry.
- Produces exactly:

```ts
[
  {
    role: 'original',
    path: 'original.crawl.json',
    mediaType: 'application/json',
  },
  {
    role: 'normalized',
    path: 'content.md',
    mediaType: 'text/markdown',
  },
  {
    role: 'asset',
    path: 'assets/crawl-inventory.json',
    mediaType: 'application/json',
  },
];
```

- [ ] **Step 1: Write failing exact-dispatch and cancellation tests**

Keep the existing empty-option single-page tests. Add table-driven invalid
crawl requests:

```ts
[
  { maxDepth: 0 },
  { maxPages: 1 },
  { maxDepth: -1, maxPages: 1 },
  { maxDepth: 0, maxPages: 11 },
  { maxDepth: 0.5, maxPages: 1 },
  { maxDepth: 0, maxPages: 1, extra: true },
];
```

Each must throw `CRAWL_INPUT_INVALID` before either injected fetch function is
called. Exactly `{ maxDepth: 0, maxPages: 1 }` invokes the injected crawler.

Pass a retained context abort signal into the single-page path and assert it
reaches the injected fetch unchanged. For crawl, inject a deadline signal and
assert the plugin creates one composed caller-plus-deadline operation signal,
passes that exact signal to the injected crawler, and never passes the raw
`context.signal` as the crawl signal.

- [ ] **Step 2: Write failing deterministic artifact tests**

Inject a complete fixed `CrawlResult` with one seed, one child gap, an applied
robots record, and skipped query/robots entries. Assert exact parsed
`original.crawl.json` property values and exact bytes for repeated runs.

Require:

- raw bodies encoded as base64;
- byte counts and SHA-256 from raw bytes;
- options ordered `maxDepth`, then `maxPages`;
- policy constants exactly as specified;
- no header, timestamp, duration, temporary directory, or exception stack;
- page/inventory array order unchanged;
- standalone asset entries deep-equal original inventory;
- combined Markdown contains successful unique pages in attempt order and the
  fixed extraction-gap blockquote;
- normalized metadata canonical URI is the requested seed and extractor is
  `source-url-crawl`;
- every descriptor byte count/hash equals the written file.

Also abort the composed operation signal at each boundary: before
serialization, after serialization before the first write, after each of the
three writes, and after descriptor calculation before return. Assert each case
rejects with the abort/`CRAWL_TOTAL_TIMEOUT` diagnostic, returns no descriptors,
leaves none of the three artifact paths, and cannot reach the publisher.

- [ ] **Step 3: Write failing seed-fatal/no-artifact test**

Make the injected crawler throw a seed URL error. Assert ingest rejects,
returns no descriptors, and none of
`original.crawl.json`, `content.md`, or
`assets/crawl-inventory.json` exists. Repeat for `CRAWL_TOTAL_TIMEOUT` and a
cancelled context signal. Also cancel the deadline signal while serialization
or an artifact write is in progress; assert partial files are removed and no
publication callback runs.

- [ ] **Step 4: Run RED**

```powershell
npm test -- packages/plugins/official/source.url/test/plugin.test.ts
```

Expected: FAIL because options other than `{}` are rejected and crawl artifacts
are not implemented.

- [ ] **Step 5: Implement exact option dispatch**

Change the plugin implementation callback to create the crawl operation signal
at operation entry, then dispatch:

```ts
ingest: async (request, context) =>
  ingestUrlOrCrawl(request, context.signal, createOperationSignal(), dependencies);
```

Empty options retain the current single-page path. Validate the two crawl keys
with integer/range checks before invoking the crawler. Do not infer operation
from URL shape and do not accept crawl booleans or missing limits.

Pass `context.signal` to the existing single-page fetch through `UrlFetchPolicy`
without adding crawl headers/options to `ingest-url`. For exactly valid crawl
options, create one 120,000-millisecond deadline signal, compose it with the
caller signal once, and pass the resulting operation signal to
`crawlPublicSite`. Do not create the deadline before option validation or for
single-page ingestion.

- [ ] **Step 6: Implement canonical JSON and Markdown serialization**

Map `CrawlResult` to the exact schema from
`docs/superpowers/specs/2026-07-25-source-url-bounded-crawl-design.md`.
Construct object literals in specified property order, use
`JSON.stringify(value, null, 2) + '\n'`, and encode bodies with
`Buffer.from(bytes).toString('base64')`.

Build `content.md` with one top heading and sections for
`contributesContent === true`. Escape heading text, retain normalized page
Markdown, add the fixed gap blockquote for empty/gap pages, normalize line
endings, and end once with `\n`.

Create `assets/` before writing the inventory. Reuse `writeArtifact` so all
three descriptors are computed from disk bytes. Use role `asset` for the
inventory because the generic publisher packages only asset roles.

Use the same composed operation signal for serialization, directory creation,
every `writeArtifact` call, descriptor calculation, and the final return
boundary. Check it before and after each operation. If it aborts, remove all
partial crawl artifacts, return no descriptors, and do not invoke or permit
publication.

- [ ] **Step 7: Run GREEN**

```powershell
npm test -- packages/plugins/official/source.url/test/plugin.test.ts packages/plugins/official/source.url/test/crawl.test.ts packages/plugins/official/source.url/test/request.test.ts
npm run typecheck
npx prettier --check packages/plugins/official/source.url/src/plugin.ts packages/plugins/official/source.url/src/index.ts packages/plugins/official/source.url/test/plugin.test.ts
git diff --check
```

Expected: single-page and crawl plugin tests PASS; repeated fixture runs
produce byte-identical artifacts.

- [ ] **Step 8: Commit**

```powershell
git add packages/plugins/official/source.url/src/plugin.ts packages/plugins/official/source.url/src/index.ts packages/plugins/official/source.url/test/plugin.test.ts
git commit -m "feat(url): bundle crawl artifacts atomically"
```

**Review gate:** Reject nondeterministic JSON, headers/timestamps in the
bundle, multiple originals, inventory role ignored by the publisher, a
canonical URI changed to effective URL, a partially returned artifact set, or
single-page behavior changed by crawl defaults. Also reject a 120-second timer
created in `crawl.ts`, a raw caller signal passed to crawl, an unguarded
serialization/write/descriptor step, or any abort that leaves artifacts or can
reach publication.

---

### Task 5: Declare capability and forward stable crawl diagnostics

**Files:**

- Modify: `packages/plugins/official/source.url/sheldon-plugin.json`
- Modify: `packages/plugins/official/source.url/sheldon-plugin.contract.json`
- Modify: `packages/plugins/official/source.url/src/plugin.ts`
- Modify: `packages/plugins/official/source.url/test/plugin.test.ts`
- Modify: `packages/plugin-host/src/process-runner.ts`
- Modify: `packages/plugin-host/test/process-runner-url-diagnostics.test.ts`

**Interfaces:**

- Official description and manifest capabilities are exactly:

```json
["ingest-url", "ingest-site"]
```

- Host-forwarded crawl codes are:

```text
CRAWL_INPUT_INVALID
CRAWL_RAW_BUDGET_EXCEEDED
CRAWL_TOTAL_TIMEOUT
URL_HTTP_STATUS
URL_REDIRECT_OUT_OF_SCOPE
URL_REQUEST_TIMEOUT
```

Existing URL codes remain forwarded and redacted.

- [ ] **Step 1: Write failing manifest/description and contract-safe tests**

Assert `plugin.describe()` returns both capabilities in that order. Read
`sheldon-plugin.json` in the plugin test and require the same array.

Keep the contract's supported URL probe and invalid `file:` ingest. Assert the
invalid ingest still fails before either page fetch or crawler is invoked.
The contract must not use a successful crawl fixture because contract
verification may not open the network.

- [ ] **Step 2: Extend failing host diagnostic cases**

Add each new code to the existing table-driven process-runner test. Use an
unsafe URL fixture containing query and fragment secrets and require:

```ts
await expect(runner.probe(plugin, input)).rejects.toMatchObject({
  code,
  message: `${code}: https://example.test/article`,
  target: 'fixture.node',
});
```

Assert retained run state stores the exact code and neither message nor
recovery contains the query/fragment secret.

- [ ] **Step 3: Run RED**

```powershell
npm run build
npm test -- packages/plugins/official/source.url/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts
npm run verify:plugin-contract
```

Expected: FAIL because the manifest lacks `ingest-site` and the host collapses
new crawl diagnostics.

- [ ] **Step 4: Update manifest, description, and deterministic contract**

Add `ingest-site` after `ingest-url` in both description and manifest. Retain
`network: true`, `cookies: false`, version, priority, platform list, and
entrypoint unchanged.

Keep `sheldon-plugin.contract.json` network-free:

```json
{
  "supportedProbe": {
    "input": {
      "url": "https://example.test/article"
    },
    "minimumConfidence": 100
  },
  "unsupportedProbe": {
    "input": {
      "url": "file:///contract-must-not-open-network"
    }
  },
  "ingest": {
    "input": {
      "url": "file:///contract-must-not-open-network"
    },
    "options": {},
    "expectedDiagnosticCode": "URL_INPUT_INVALID"
  }
}
```

- [ ] **Step 5: Forward and redact crawl diagnostics**

Add all six codes to `sourceDiagnosticCodes`. Expand `urlDiagnosticCodes` to
include prefixes `URL_`, `YOUTUBE_`, and `CRAWL_` so the existing safe URL
redaction path applies. Do not change file/repository diagnostics or unknown
plugin error wrapping.

- [ ] **Step 6: Run GREEN**

```powershell
npm run build
npm test -- packages/plugins/official/source.url/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts
npm run verify:plugin-contract
npm run typecheck
git diff --check
```

Expected: source.url contract passes without a network request and every old
and new URL/crawl code is preserved.

- [ ] **Step 7: Commit**

```powershell
git add packages/plugins/official/source.url/sheldon-plugin.json packages/plugins/official/source.url/sheldon-plugin.contract.json packages/plugins/official/source.url/src/plugin.ts packages/plugins/official/source.url/test/plugin.test.ts packages/plugin-host/src/process-runner.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts
git commit -m "feat(url): declare bounded crawl capability"
```

**Review gate:** Reject a live-network contract, `ingest-site` on
`source.youtube`, relaxed network/cookie permissions, unsafe query echo, or
changes to release/catalog enumeration.

---

### Task 6: Add explicit CLI routing and publication acceptance

**Files:**

- Modify: `apps/cli/src/commands/memory.ts`
- Modify: `apps/cli/src/main.ts`
- Create: `apps/cli/test/crawl-ingestion-acceptance.test.ts`
- Modify: `apps/cli/test/main.test.ts`
- Modify: `apps/cli/test/url-ingestion-acceptance.test.ts`

**Interfaces:**

- Consumes: existing `canonicalUrl`, `PluginSelector`,
  `publishPluginSourceIngestion`, vault/entity resolution, and validated
  artifact lease.
- Produces:

```ts
export interface CrawlIngestionOptions extends VaultOption {
  readonly plugin?: string;
  readonly maxDepth: 0 | 1 | 2;
  readonly maxPages: number;
}

export async function ingestCrawl(
  kind: EntityKind,
  slug: string,
  seed: string,
  options: CrawlIngestionOptions,
  context: CommandContext,
): Promise<void>;
```

The CLI parser is:

```ts
function boundedInteger(
  name: '--max-pages' | '--max-depth',
  minimum: number,
  maximum: number,
): (value: string) => number {
  return (value) => {
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
      throw new InvalidArgumentError(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    const parsed = Number(value);
    if (parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
  };
}
```

- [ ] **Step 1: Write failing help and option-validation tests**

Require help to contain:

```text
sheldon ingest crawl [options] <kind> <slug> <seed-url>
--max-pages <count>
--max-depth <depth>
--vault <path>
--plugin <id>
```

For each missing option and values `-1`, `+1`, `1.0`, `1e0`, whitespace,
`NaN`, and the out-of-range endpoints `0`/`11` for pages and `-1`/`3` for
depth, require nonzero exit and the exact bounded-integer message. Install no
plugin and assert plugin discovery/launch markers are absent.

- [ ] **Step 2: Write failing installed-plugin acceptance harness**

Create an installed fixture with only `ingest-site`. Its probe accepts
`input.url`; ingest records input/options and writes:

```text
original.crawl.json
content.md
assets/crawl-inventory.json
```

Return correct descriptor hashes and normalized metadata
`canonicalUri: input.url`, `extractor: fixture-crawl`,
`format: crawl-markdown`, `extractionStatus`, and `warnings`.

Invoke:

```text
sheldon ingest crawl topic example https://example.test/start?edition=cli \
  --max-pages 3 --max-depth 2 --vault <vault>
```

Require selection capability `ingest-site`, canonical input, numeric options
`{ maxDepth: 2, maxPages: 3 }`, manifest options with the same values, original
path `original.json`, normalized path `content.md`, and inventory path
`assets/crawl-inventory.json`.

- [ ] **Step 3: Write failing dedupe, revision, and isolation acceptance**

In the fixture:

1. Run identical bundle/options twice and require the second publication
   `deduplicated: true` with the same source ID.
2. Change raw bundle bytes at the same seed/options and require a new source ID
   whose manifest `previous_source_id` is the first.
3. Restore bytes and change `maxDepth` or `maxPages`; require a distinct source
   identity/options hash and no false dedupe.
4. Return a plugin failure before descriptors; require no new raw directory.
5. Install an equal-priority second `ingest-site` plugin; require ambiguity
   without `--plugin` and exact selection with it.

Retain/extend URL acceptance assertions proving ordinary
`ingest url` selects `ingest-url`, YouTube still wins its specialized
`ingest-url` selection, URL language is forwarded only through that command,
and neither existing plugin receives crawl options.

- [ ] **Step 4: Run RED**

```powershell
npm test -- apps/cli/test/crawl-ingestion-acceptance.test.ts apps/cli/test/main.test.ts apps/cli/test/url-ingestion-acceptance.test.ts
```

Expected: FAIL because `ingest crawl`, its option type/parser, and fixture
routing do not exist.

- [ ] **Step 5: Implement strict Commander registration**

Import `InvalidArgumentError`. Register:

```ts
ingest
  .command('crawl <kind> <slug> <seed-url>')
  .requiredOption(
    '--max-pages <count>',
    'maximum page attempts (1-10)',
    boundedInteger('--max-pages', 1, 10),
  )
  .requiredOption(
    '--max-depth <depth>',
    'maximum link depth (0-2)',
    boundedInteger('--max-depth', 0, 2),
  )
  .option('--vault <path>', 'explicit vault path')
  .option('--plugin <id>', 'explicit site ingestion plugin')
  .action((kind, slug, seed, options: CrawlIngestionOptions) =>
    ingestCrawl(kind, slug, seed, options, context),
  );
```

Do not add crawl flags to `ingest url`.

- [ ] **Step 6: Implement `ingestCrawl` with the unchanged publisher**

Canonicalize through the existing URL helper. Build only:

```ts
const input = { url: canonical.href };
const pluginOptions = {
  maxDepth: options.maxDepth,
  maxPages: options.maxPages,
};
```

Select capability `ingest-site`, preserve the existing deterministic ambiguous
candidate message, and pass `pluginOptions` unchanged to runner and publisher.
Require exactly one original descriptor and derive its safe basename for
`originalName`. Call `publishPluginSourceIngestion`; do not add any per-page
loop or publisher special case.

- [ ] **Step 7: Run GREEN**

```powershell
npm test -- apps/cli/test/crawl-ingestion-acceptance.test.ts apps/cli/test/main.test.ts apps/cli/test/url-ingestion-acceptance.test.ts apps/cli/test/memory.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts
npm run typecheck
npm run build
npx prettier --check apps/cli/src/commands/memory.ts apps/cli/src/main.ts apps/cli/test/crawl-ingestion-acceptance.test.ts apps/cli/test/main.test.ts apps/cli/test/url-ingestion-acceptance.test.ts
git diff --check
```

Expected: crawl publication/dedupe/revision tests PASS, existing URL/YouTube
acceptance remains unchanged, and publisher tests require no modification.

- [ ] **Step 8: Commit**

```powershell
git add apps/cli/src/commands/memory.ts apps/cli/src/main.ts apps/cli/test/crawl-ingestion-acceptance.test.ts apps/cli/test/main.test.ts apps/cli/test/url-ingestion-acceptance.test.ts
git commit -m "feat(cli): ingest bounded site crawls"
```

**Review gate:** Reject optional limits, coercive numeric parsing,
`ingest-url` selection, a CLI network request, string-valued plugin limits,
publisher changes, per-page raws, or any change in ordinary URL/YouTube
selection.

---

### Task 7: Run full bounded verification and adversarial review

**Files:**

- No source changes expected.
- Modify only files already listed in Tasks 1-6 if a verified defect requires
  a fix.

- [ ] **Step 1: Run focused security and behavior suites**

```powershell
npm test -- packages/plugins/official/source.url/test/request.test.ts packages/plugins/official/source.url/test/links.test.ts packages/plugins/official/source.url/test/robots.test.ts packages/plugins/official/source.url/test/crawl.test.ts packages/plugins/official/source.url/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts packages/ingestion/test/plugin-file-ingestor.test.ts apps/cli/test/crawl-ingestion-acceptance.test.ts apps/cli/test/url-ingestion-acceptance.test.ts apps/cli/test/main.test.ts apps/cli/test/memory.test.ts
```

Expected: PASS with zero external DNS/HTTP and no skipped boundary case.

- [ ] **Step 2: Run repository gates**

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run lint:md
npm run test
npm run coverage
npm run build
npm run verify:plugin-contract
npm run lint:domain
npm run lint:repo
git diff --check
```

Expected: every command exits 0. `verify:plugin-contract` reports
`source.url: contract passed`; no OCR/native build, release build, signing,
catalog mutation, tag, upload, or external crawl occurs.

- [ ] **Step 3: Perform a whole-feature adversarial review**

Review the complete diff against
`docs/superpowers/specs/2026-07-25-source-url-bounded-crawl-design.md`. Try to
construct failures for:

- DNS rebinding or off-origin/query redirect before scope checks;
- seed effective-origin confusion;
- robots fetched too late, bypassed, or permissively parsed;
- BFS order changed by response timing, DOM order, or locale;
- requested/effective alias loops and duplicate child expansion;
- page/depth/candidate/redirect/byte/time off-by-one boundaries;
- aggregate budget charged only for successful pages;
- cancellation converted to partial publication;
- child failure suppressing later siblings;
- policy skips incorrectly setting extraction gaps;
- headers/timestamps/runtime paths entering deterministic JSON;
- identical crawl/options failing dedupe or changed bytes failing revision
  linkage;
- accidental `ingest url`, YouTube, publisher, README/roadmap,
  OCR/native-runtime, release, or catalog changes.

Reject the feature for any reproducible violation. Fix only the responsible
Task 1-6 file, add a regression test beside the failure, and rerun Steps 1-2.

- [ ] **Step 4: Confirm final scope**

```powershell
git status --short
git diff --name-only HEAD
git diff --check
```

Expected: the implementation diff contains only the files enumerated in Tasks
1-6. It contains no README, roadmap, changelog, OCR/native, release, catalog,
or `.superpowers/sdd/*report*` path.

## Requirements-to-tasks traceability

| Requirement                 | Implemented by   | Primary verification                                                           |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| R1 explicit command/options | Tasks 4, 6       | CLI malformed/range table and pre-network plugin validation                    |
| R2 capability isolation     | Tasks 5, 6       | manifest/description checks and URL/YouTube acceptance                         |
| R3 SSRF/request policy      | Task 1           | existing address suite plus headers, redirect predicate, timeout, cancellation |
| R4 effective-origin scope   | Tasks 1, 3       | redirected seed and blocked child/robots redirect tests                        |
| R5 deterministic BFS/dedupe | Tasks 2, 3       | request trace, concurrency counter, fragment/request/effective alias cases     |
| R6 robots                   | Tasks 2, 3       | parser precedence suite and no-request integration                             |
| R7 strict limits            | Tasks 1, 2, 3, 6 | exact byte/time/page/depth/candidate/CLI boundaries                            |
| R8 failure/gap semantics    | Tasks 3, 4       | seed-fatal, child-continue, policy-skip, and normalization-gap tests           |
| R9 atomic publication       | Tasks 4, 6       | exact three artifacts, no-fatal raw, dedupe/revision/options acceptance        |
| Compatibility/deferrals     | Tasks 5-7        | URL/YouTube regressions, final diff scope, and full repository gates           |

## Completion condition

The implementation is complete only when all seven task review gates pass,
every requirements row has its named test evidence, and the final diff contains
no deferred-scope file or behavior.
