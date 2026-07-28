# Source URL bounded crawl requirements and design

## Goal

Extend the official `source.url` connector with an explicit, bounded site-crawl
operation:

```text
sheldon ingest crawl <kind> <slug> <seed-url> \
  --max-pages <1..10> \
  --max-depth <0..2>
```

The crawl captures a deterministic, sequential breadth-first slice of one
public web origin. It publishes one atomic source revision containing a
deterministic crawl bundle, combined Markdown, and a URL inventory. The
existing `sheldon ingest url` and YouTube selection behavior remain unchanged.

This design is the bounded crawl portion of PRD 003. It intentionally favors a
small, auditable network and publication boundary over crawler breadth.

## Approved approach

Three boundaries were considered:

1. Make `ingest url` infer whether it should crawl from optional flags. This
   would make a command that currently fetches one page change behavior based
   on loosely coupled options and would expose crawl options to
   `source.youtube`.
2. Add a separate crawler plugin. This would duplicate the existing URL
   validation, pinned-address transport, normalization, and official-package
   plumbing before the policies have materially diverged.
3. Add an explicit `ingest crawl` command and an `ingest-site` capability to
   `source.url`, while keeping `ingest-url` page-only.

Approach 3 is selected. Command intent and plugin capability are explicit,
`source.url` reuses its SSRF-safe request boundary, and no existing URL or
YouTube invocation acquires crawl behavior.

## Requirement terminology

- **Seed URL** is the canonical HTTP(S) URL supplied explicitly by the user.
- **Page attempt** is one top-level call that fetches the seed or one selected
  child candidate. Redirect hops inside that call are not separate page
  attempts.
- **Effective URL** is the final response URL after validated redirects.
- **Effective origin** is the exact `URL.origin` of the seed's effective URL.
- **Candidate** is a unique normalized URL produced from an HTML
  `<a href="...">` value. The seed is not a discovered candidate.
- **Depth 0** is the seed. A link extracted from a page at depth `n` is a
  candidate for depth `n + 1`.
- **Visited page** is a successful page attempt whose effective URL has not
  already been visited.
- **Requested dedupe** means a canonical requested URL is attempted at most
  once.
- **Effective dedupe** means redirect aliases may be attempted, but only the
  first successful response for an effective URL contributes content or child
  links.
- **Lexical order** means ascending JavaScript string code-unit order using
  `(left < right ? -1 : left > right ? 1 : 0)`, never locale-sensitive
  collation.

## Functional requirements

### R1. Explicit command and validated options

1. The CLI exposes only:

   ```text
   sheldon ingest crawl <kind> <slug> <seed-url> \
     --max-pages <1..10> \
     --max-depth <0..2> \
     [--vault <path>] \
     [--plugin <id>]
   ```

2. `--max-pages` and `--max-depth` are required. Their values must be decimal
   integer strings with no sign, fraction, exponent, whitespace, or trailing
   characters.
3. The CLI rejects `max-pages` outside `1..10` and `max-depth` outside `0..2`
   before plugin discovery or launch.
4. The seed passes the same canonical HTTP(S), no-credentials, no-fragment,
   and no-non-default-port validation as `ingest url`. An explicit seed query
   is allowed and retained.
5. The CLI selects only a plugin that declares `ingest-site`. It sends:

   ```json
   {
     "input": {
       "url": "https://example.test/start?edition=explicit"
     },
     "options": {
       "maxDepth": 2,
       "maxPages": 10
     }
   }
   ```

6. The exact plugin options are also passed to the generic source publisher so
   they participate in source identity and revision history.
7. The official `source.url` plugin independently validates exact input and
   option keys and ranges. Unknown or malformed crawl input fails with
   `CRAWL_INPUT_INVALID` before any network request.

### R2. Capability isolation

1. `source.url` declares both `ingest-url` and `ingest-site`.
2. `source.youtube` continues to declare only `ingest-url`.
3. `sheldon ingest url` continues to select `ingest-url`, keeps its optional
   YouTube `--language` behavior, and continues to reject crawl options.
4. `sheldon ingest crawl` never selects `source.youtube`, never forwards a
   language option, and never falls back to `ingest-url`.

### R3. Reused SSRF-safe request boundary

1. The seed, robots policy, every child, and every redirect use the existing
   `fetchPublicUrl` validation and pinned-address transport.
2. Only absolute `http:` and `https:` URLs without credentials, fragments, or
   non-default ports may be requested.
3. Before every connection, all DNS answers are checked. A hostname is
   rejected if any answer is loopback, unspecified, private, link-local,
   multicast, reserved, IPv4-mapped unsafe IPv6, local-use translation, or
   otherwise non-globally-routable under the existing address policy.
4. The actual socket connects to the already-validated address and host pair.
   HTTPS retains certificate verification and SNI.
5. Every top-level fetch permits at most five validated redirects and at most
   5,242,880 streamed response bytes.
6. Crawl requests send the fixed headers:

   ```text
   User-Agent: SheldonBot/1.0
   Accept: text/html, application/xhtml+xml, text/plain, text/markdown;q=0.9
   Accept-Encoding: identity
   ```

   The transport sends no `Referer`, `Cookie`, `Authorization`, conditional
   request header, caller-provided header, or proxy setting.

7. Each top-level fetch, including all of its redirect hops and streamed body,
   has a 15,000 millisecond deadline.
8. At the start of an `ingest-site` plugin operation, the plugin composes the
   caller signal with the fixed 120,000-millisecond operation deadline. That
   one composed operation signal is passed into every DNS/transport/body
   operation. Cancellation or deadline expiry stops the in-flight request and
   produces no artifacts or source publication.
9. Query and fragment values remain redacted from user-visible errors. The
   deterministic source bundle may retain fetched source URLs because it is
   the user's captured raw artifact.

### R4. Effective-origin scope

1. The seed may redirect across public origins. Its final effective response
   origin becomes the crawl's sole scope anchor.
2. Discovered candidates are eligible only when their canonical `URL.origin`
   exactly equals that anchor, including scheme, normalized hostname, and
   effective port.
3. A child redirect is checked before connecting. A redirect outside the
   effective origin or to a URL with a query is not followed and records the
   child attempt as failed with `URL_REDIRECT_OUT_OF_SCOPE`.
4. A robots redirect is likewise limited to the effective origin and a
   query-free URL.
5. Subdomains, sibling domains, scheme changes, and alternate ports are
   outside scope even when they share a registrable domain.

### R5. Deterministic sequential BFS

1. The seed is page attempt 1 at depth 0.
2. Only successful unique HTML/XHTML responses contribute links. Plain text
   and Markdown responses contribute content but no candidates.
3. HTML link extraction reads only `a[href]`. It ignores `<base>`, resolves
   each `href` against the page's effective URL, and strips the fragment before
   filtering and dedupe.
4. JavaScript URLs, forms, buttons, images, media, stylesheets, scripts,
   iframes, meta refresh, canonical tags, and sitemap declarations never add a
   candidate.
5. A discovered URL with any query delimiter, including an empty `?`, is
   recorded as skipped and is never requested. This does not remove or alter
   an explicit seed query.
6. Candidates outside the effective origin or using another scheme are
   recorded as skipped and never requested.
7. The crawler aggregates eligible candidates for the next depth, deduplicates
   them by canonical requested URL, sorts them lexically, and then processes
   them one at a time. There is no concurrent DNS lookup or request.
8. A canonical requested URL is attempted once at most. Repeated discoveries
   merge their lexically sorted `discoveredFrom` effective URLs into one
   inventory entry.
   Malformed href values are summarized by one redacted `invalid-url` entry
   rather than copied into the inventory.
9. A successful response whose effective URL was already visited is recorded
   as `duplicate-effective`. Its raw response remains evidence in the crawl
   bundle, but it adds no Markdown section and contributes no links.
10. Links found at `maxDepth` are classified as `depth-limit` without being
    requested. Eligible candidates left after the page-attempt budget is
    exhausted are classified as `page-limit`.
11. Crawl order, page-section order, inventory order, warnings, hashes, and
    serialized JSON are stable for identical response bytes and options.

### R6. Robots policy for child traversal

1. The seed is an explicit user request and is not blocked by robots policy.
2. Robots is not requested when no child could be attempted: `maxDepth` is 0,
   `maxPages` is 1, the seed is non-HTML, seed normalization cannot yield
   links, or no eligible child candidate exists.
3. Immediately before the first child decision, the crawler requests
   `<effective-origin>/robots.txt` once with the same SSRF, redirect, request
   header, deadline, and aggregate-byte controls as pages.
4. The robots request does not consume a `maxPages` slot. It does consume the
   120,000 millisecond total deadline and 26,214,400-byte aggregate raw budget.
5. HTTP 404 and 410 mean no robots policy is present and permit child
   traversal. A 2xx `text/plain` UTF-8 body is parsed. Any other status,
   unsupported media type, invalid UTF-8, network/policy error, or malformed
   applicable rule makes robots unreadable or ambiguous.
6. Parsing is deterministic and case-insensitive for field names and
   user-agent product tokens. The parser merges groups that exactly match
   `SheldonBot`; if none match, it merges `*` groups. It implements `Allow` and
   `Disallow` with `*` and a terminal `$`, longest matching rule wins, and
   `Allow` wins equal-length ties. An empty `Disallow` permits access.
7. Blank lines and `#` comments are supported. `Sitemap` and other
   non-access-control fields are ignored. A malformed applicable
   `User-agent`, `Allow`, or `Disallow`, or an applicable `Crawl-delay`, is
   ambiguous because this slice cannot safely honor it.
8. The rule match input is the candidate's percent-encoded pathname. Queries
   never reach robots evaluation because discovered queries are already
   skipped.
9. A disallowed child is recorded as `robots-disallowed` and is never
   requested.
10. Unreadable or ambiguous robots halts all child traversal. Every currently
    known eligible child is recorded as `robots-unavailable`; no deeper
    candidates can arise because no child is requested.

### R7. Strict crawl limits

The following limits are fixed and may not be raised by plugin options:

| Limit          |        Exact value | Semantics                                                                                                                                   |
| -------------- | -----------------: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages          |            `1..10` | User-selected top-level page attempts. Seed, failed child attempts, and redirect aliases each consume one. Redirect hops and robots do not. |
| Depth          |             `0..2` | User-selected BFS depth with seed at 0.                                                                                                     |
| Per fetch      |  `5,242,880` bytes | Streamed bytes accepted across one top-level fetch, including failed bodies.                                                                |
| Aggregate raw  | `26,214,400` bytes | Streamed body bytes accepted across seed, robots, children, and failures. Redirect responses are not drained.                               |
| Per fetch time |        `15,000` ms | All redirect hops and body streaming for one top-level fetch.                                                                               |
| Total time     |       `120,000` ms | Starts at `ingest-site` plugin-operation entry and covers seed, robots, traversal, normalization, serialization, and artifact writes.       |
| Redirects      |                `5` | Per top-level fetch.                                                                                                                        |
| Candidates     |            `1,000` | Globally new normalized discovered URLs after candidate, requested-URI, and effective-URI dedupe; seed requested/effective URLs excluded.   |

1. Link extraction receives the crawler's known candidate, requested, and
   effective URI set plus the remaining globally new capacity. Known links do
   not consume that capacity and remain available for `discoveredFrom`
   merging. The parser retains at most the known URI set size plus the
   remaining globally new capacity. Globally new candidate 1,001 is not
   retained; extraction stops, a single `candidate-limit` sentinel is added to
   the inventory, and a deterministic warning records truncation.
2. Aggregate bytes are charged while streaming, including bytes from child
   attempts that later fail and the robots response. The request is aborted
   before accepting bytes beyond the remaining budget.
3. If the aggregate budget is exhausted during a child or robots request, that
   attempt records `CRAWL_RAW_BUDGET_EXCEEDED`, traversal stops, and the
   already completed crawl result may be published. Eligible children known
   but not attempted after child-request exhaustion are classified as
   `raw-budget-limit`, never `page-limit`.
4. Total deadline expiry or user cancellation is operation-fatal: it returns
   no descriptors, leaves no crawl artifacts, and invokes no publication. The
   plugin does not convert cancellation into a child failure.

### R8. Failure and extraction-gap semantics

1. Any seed request failure, forbidden address, invalid redirect, unsupported
   content type, non-2xx status, response limit, or per-fetch timeout is fatal.
   No artifact is returned or published.
2. A successful 2xx seed with invalid UTF-8, empty usable content, or
   normalization failure remains a captured seed with
   `extractionStatus: "gap"` and no child traversal.
3. A child request or HTTP failure is recorded, consumes one page attempt, and
   does not stop later siblings unless a global time/raw limit has been
   reached.
4. A child normalization failure is recorded as a visited page with an
   extraction gap. Its raw body is retained; it contributes a deterministic
   gap section and no child links.
5. The combined normalized artifact has `extractionStatus: "gap"` only when an
   attempted page failed or an attempted page could not be normalized
   completely. Scope, query, robots, depth, page, candidate, requested-dedupe,
   and effective-dedupe skips do not by themselves create an extraction gap.
6. A robots halt, including an unreadable robots response or aggregate-budget
   stop during the robots fetch, is an intentional policy stop and not an
   extraction gap.
7. Warnings are stable codes sorted first by page-attempt sequence and then by
   code. They never contain response headers, timestamps, query secrets, raw
   credentials, or runtime exception text.

### R9. Atomic one-source publication

The plugin returns exactly three host-validated artifacts:

1. `original.crawl.json`, role `original`, media type `application/json`;
2. `content.md`, role `normalized`, media type `text/markdown`;
3. `assets/crawl-inventory.json`, role `asset`, media type
   `application/json`.

The generic publisher already requires one original and one normalized
artifact and packages assets below `assets/`. No publisher change is required.
The plugin checks the composed operation signal before and after serialization,
before and after every artifact write, and immediately before returning
descriptors. All three artifacts are materialized before the lease callback
publishes a single raw source. If that signal aborts at any point, the plugin
removes any partial crawl artifacts, returns no descriptors, and never invokes
publication.

The normalized metadata is exactly:

```json
{
  "canonicalUri": "https://example.test/start?edition=explicit",
  "extractor": "source-url-crawl",
  "format": "crawl-markdown",
  "extractionStatus": "complete",
  "warnings": []
}
```

`canonicalUri` is the canonical requested seed, not its effective URL. This
keeps revision history attached to the user's stable source identity. Changed
bundle bytes with the same seed/options create a new revision linked through
`previous_source_id`; byte-identical bundles with the same options deduplicate.
Different `maxPages` or `maxDepth` values produce distinct source identities.
There are no per-page source revisions.

## Deterministic artifact formats

### `original.crawl.json`

JSON is UTF-8, two-space indented, ends with one newline, and uses the property
order shown below. Arrays retain deterministic crawl/inventory order. It
contains no response headers, wall-clock timestamps, durations, temporary
paths, or platform-dependent separators.

```json
{
  "schemaVersion": 1,
  "seed": {
    "requestedUri": "https://example.test/start?edition=explicit",
    "effectiveUri": "https://www.example.test/home"
  },
  "scope": {
    "origin": "https://www.example.test"
  },
  "options": {
    "maxDepth": 2,
    "maxPages": 10
  },
  "policy": {
    "userAgent": "SheldonBot/1.0",
    "perFetchTimeoutMilliseconds": 15000,
    "totalTimeoutMilliseconds": 120000,
    "maximumResponseBytes": 5242880,
    "maximumAggregateRawBytes": 26214400,
    "maximumCandidates": 1000
  },
  "robots": {
    "status": "applied",
    "requestedUri": "https://www.example.test/robots.txt",
    "effectiveUri": "https://www.example.test/robots.txt",
    "httpStatus": 200,
    "mediaType": "text/plain",
    "bytes": 27,
    "sha256": "a92d287a72a3f39a55e2848ec6af83163ae1c28172d2e2d89a45a105db0e2540",
    "bodyBase64": "VXNlci1hZ2VudDogKgpEaXNhbGxvdzogL3gK"
  },
  "pages": [
    {
      "attempt": 1,
      "depth": 0,
      "requestedUri": "https://example.test/start?edition=explicit",
      "effectiveUri": "https://www.example.test/home",
      "httpStatus": 200,
      "mediaType": "text/html",
      "bytes": 14,
      "sha256": "e2c6c0ea7c7900c31f953e48d30d5e839801ab90630d751e7c8426ed5859da47",
      "bodyBase64": "PGgxPkhlbGxvPC9oMT4=",
      "extractionStatus": "complete",
      "warnings": []
    }
  ],
  "inventory": [
    {
      "sequence": 1,
      "depth": 0,
      "requestedUri": "https://example.test/start?edition=explicit",
      "effectiveUri": "https://www.example.test/home",
      "status": "visited",
      "reason": "seed",
      "discoveredFrom": []
    },
    {
      "sequence": 2,
      "depth": 1,
      "requestedUri": "https://www.example.test/private",
      "status": "skipped",
      "reason": "robots-disallowed",
      "discoveredFrom": ["https://www.example.test/home"]
    }
  ]
}
```

`robots.status` is one of `not-needed`, `absent`, `applied`, `unreadable`, or
`ambiguous`. Fields after `status` are present only when the corresponding
response value exists. A fetched robots body is retained with the same
byte/hash/base64 fields as a page.

Each `pages` item represents a response body received for a page attempt.
Effective duplicates are retained in `pages` with
`extractionStatus: "complete"` or `"gap"` but have an inventory reason of
`duplicate-effective`; they do not appear in `content.md`.

Inventory `status` is `visited`, `failed`, or `skipped`. `reason` is one of:

```text
seed
page
duplicate-requested
duplicate-effective
invalid-url
unsupported-scheme
outside-origin
query
robots-disallowed
robots-unavailable
depth-limit
page-limit
raw-budget-limit
candidate-limit
URL_ADDRESS_FORBIDDEN
URL_REDIRECT_INVALID
URL_REDIRECT_LIMIT
URL_REDIRECT_OUT_OF_SCOPE
URL_RESPONSE_TOO_LARGE
URL_CONTENT_TYPE_UNSUPPORTED
URL_RESPONSE_UNREADABLE
URL_REQUEST_TIMEOUT
URL_HTTP_STATUS
CRAWL_RAW_BUDGET_EXCEEDED
URL_CONTENT_UTF8_INVALID
URL_CONTENT_EMPTY
URL_CONTENT_CONVERSION_FAILED
```

An invalid URL without a safe absolute representation uses `target` instead
of `requestedUri`. `target` is a fixed redacted token such as
`"[invalid href]"`; it never copies credentials or query values.

### `assets/crawl-inventory.json`

This file is a deterministic standalone projection:

```json
{
  "schemaVersion": 1,
  "seedRequestedUri": "https://example.test/start?edition=explicit",
  "scopeOrigin": "https://www.example.test",
  "entries": []
}
```

`entries` is byte-for-byte the same inventory array represented in the
original bundle. Keeping it as an asset makes the PRD 003 visited/skipped/failed
inventory independently consumable without changing the generic publisher.

### `content.md`

Sections follow successful unique page-attempt order, which is deterministic
BFS order:

```markdown
# Crawl: https://example.test/start?edition=explicit

## https://www.example.test/home

# Hello

## https://www.example.test/about

About this site.
```

A normalization gap uses a fixed marker and does not invent page text:

```markdown
## https://www.example.test/broken

> Extraction gap: URL_CONTENT_UTF8_INVALID
```

The document always ends with one newline. Page content is normalized through
the existing `normalizeUrlContent` function. Crawl headings are escaped so a
URL cannot alter Markdown structure.

## Component design

### `request.ts`

The existing module remains the only DNS and socket boundary. Its public fetch
result gains `status`. A backward-compatible third argument carries crawl-only
policy:

```ts
export interface UrlFetchPolicy {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowRedirect?: (target: URL) => boolean;
  readonly consumeBytes?: (bytes: number) => void;
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

Existing callers omit `policy` and keep single-page behavior. Crawl supplies
the fixed headers, deadline, composed abort signal, redirect predicate, and
aggregate byte charger. The production transport accepts only the request
headers created by this module.

### `links.ts`

This module owns strict UTF-8 HTML parsing and `a[href]` discovery. It uses the
already transitive `@mixmark-io/domino` parser as a declared direct dependency
instead of a regular expression. It returns typed candidate decisions without
network activity. It ignores `<base>` and takes the effective page URL
explicitly. The crawler also supplies a bounded known-URI set and the remaining
globally new candidate capacity. The parser retains known matches for
provenance without charging them to that capacity, so page-local discovery
cannot hide a later globally new candidate.

### `robots.ts`

This module owns robots parsing and rule matching. It has no network access.
`crawl.ts` fetches the body through `request.ts` and passes bytes into
`parseRobotsPolicy(bytes, 'SheldonBot')`. Parse results are `rules`,
`ambiguous`, or `unreadable`, making traversal-halt behavior explicit and
unit-testable.

### `crawl.ts`

This module owns the aggregate byte budget, robots fetch, sequential BFS
frontier, page/requested/effective sets, inventory, and raw bundle model. It
receives the already-composed operation signal and `fetchPublicUrl` as
dependencies. It performs no filesystem writes and never creates the
120-second deadline itself.

```ts
export interface CrawlOptions {
  readonly maxDepth: 0 | 1 | 2;
  readonly maxPages: number;
}

export interface CrawlDependencies extends UrlRequestDependencies {
  readonly fetchPublicUrl?: typeof fetchPublicUrl;
}

export async function crawlPublicSite(
  seed: string,
  options: CrawlOptions,
  signal: AbortSignal,
  dependencies?: CrawlDependencies,
): Promise<CrawlResult>;
```

The crawler checks its supplied operation signal before and after fetch,
normalization, and candidate expansion. The plugin owns deadline creation plus
the serialization/artifact checks, so a testable plugin-level deadline-signal
factory lets Vitest cover the 120-second operation limit without waiting.

### `plugin.ts`

The plugin dispatches by exact option shape:

- empty options retain the current one-page `ingest-url` behavior;
- exactly `{ maxDepth, maxPages }` invokes `crawlPublicSite`;
- any other shape fails before network access.

The `ingest-site` CLI always supplies both options. At crawl-operation entry,
the plugin creates the 120-second deadline signal and composes it with
`context.signal` once. It passes that same operation signal to the crawler and
uses it while serializing, writing all three artifacts, and computing
descriptors from written bytes. An abort at any of those checkpoints removes
partial artifacts, returns no descriptors, and prevents publication.

### CLI

`memory.ts` gains `ingestCrawl` beside `ingestUrl`. It canonicalizes the seed,
selects `ingest-site`, sends numeric plugin options, requires exactly one
validated original, and calls the existing `publishPluginSourceIngestion`.
`main.ts` owns strict Commander option parsing and command registration. No
generic publisher, vault schema, release list, or catalog change is needed.

## Acceptance criteria

1. `ingest crawl` rejects missing, fractional, signed, nonnumeric, and
   out-of-range limits before plugin launch.
2. The official plugin rejects malformed/extra crawl options before any
   request and declares `ingest-site` consistently in description and
   manifest.
3. `maxDepth: 0` or `maxPages: 1` fetches only the seed and does not fetch
   robots.
4. A redirected seed anchors exact scope to its effective origin; links back
   to the originally requested origin are outside scope unless origins are
   equal.
5. A child redirect cannot cause an off-origin or query-bearing request.
6. Resolver/transport fixtures prove every seed, robots, child, and redirect
   target receives the existing SSRF validation and pinned address.
7. Crawl requests use the fixed user agent, identity encoding, no referrer,
   and no cookies/auth headers.
8. Per-fetch timeout, total timeout, cancellation, 5 MiB response,
   25 MiB aggregate, 10-page, depth-2, five-redirect, and 1,000 globally new
   candidate limits each have a deterministic boundary test. The candidate
   test proves known candidate/requested/effective URIs do not hide a later
   globally new URI, and the aggregate test distinguishes `raw-budget-limit`
   from true `page-limit`.
9. Sequential request observation proves no overlapping fetches and exact
   BFS/lexical order.
10. Fragment variants and repeated links request once. Two aliases that
    redirect to one effective URL retain both raw responses but emit one
    Markdown section and no duplicate child expansion.
11. Discovered query URLs are inventoried but unrequested; an explicit seed
    query is fetched and retained as canonical provenance.
12. Robots allow/disallow precedence, wildcard/end-anchor handling,
    user-agent selection, 404/410 absence, disallowed-no-request behavior, and
    unreadable/ambiguous traversal halt are covered without external network.
13. Seed fetch failure returns no artifacts and creates no raw directory.
    Child failure is inventoried and later lexical siblings continue.
14. Attempted request/normalization failures set the combined extraction
    status to `gap`; policy and configured-limit skips alone do not.
15. Repeated identical responses/options produce byte-identical artifacts and
    publisher dedupe. Changed response bytes at the same seed/options produce
    a linked revision. Changed limits produce a distinct source identity.
16. One published raw contains one original crawl bundle, one `content.md`,
    and one inventory asset; there are no per-page raw revisions.
17. Existing `source.url` request/plugin tests and URL CLI acceptance stay
    green. Ordinary pages still select `source.url`; YouTube URLs still select
    `source.youtube`; `ingest url` accepts no crawl options.
18. All tests use injected transports or installed local fixture plugins and
    make zero external network requests.

## Explicit deferrals

This slice does not implement:

- custom include/exclude path patterns or user-defined crawl policies;
- discovered query crawling, query allowlists, or parameter normalization;
- subdomain or registrable-domain scope;
- sitemap discovery, parsing, or seeding;
- JavaScript rendering, browser automation, or client-side route discovery;
- forms, meta refresh, canonical-link traversal, feeds, or non-anchor links;
- downloaded images, media, stylesheets, scripts, document attachments, or
  other page assets;
- authentication, cookies, authorization headers, browser/session import,
  proxy configuration, or custom request headers;
- custom user agents, referrers, crawl delay, or robots overrides;
- concurrency, retries, backoff, alternate DNS races, or connection pooling;
- resume, checkpoints, partial-publication recovery, or persisted frontier
  state;
- per-page source revisions or independent per-page publication;
- paywall/DRM bypass, paid crawling APIs, or Firecrawl;
- changes to `sheldon ingest url`, YouTube playlists/channels, or local STT.

No roadmap, README, changelog, OCR/native-runtime, release, signing, catalog,
or user task-report update belongs to this implementation slice.
