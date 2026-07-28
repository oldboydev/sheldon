# Source URL single-page ingestion design

## Goal

Implement the official `source.url` plugin and `sheldon ingest url <url>` command for one public web page per invocation. The command stores the fetched response as the original artifact and a normalized Markdown representation as the normalized artifact, then publishes both through the same memory ingestion path used by file sources.

## Scope and non-goals

- Accept only one absolute `http:` or `https:` URL per command.
- Fetch public unauthenticated content only; do not send cookies, credentials, authorization headers, or a caller-provided proxy.
- Do not crawl, follow page links, ingest sitemaps, bypass paywalls/DRM, call paid APIs, or implement YouTube ingestion.
- Reject URL-plugin options other than the fixed, internally owned policy. Crawl options are invalid rather than silently ignored.
- The plugin runs with `network: true` but is still responsible for request validation; host process isolation is not an OS network sandbox.

## Command and publication flow

1. `sheldon ingest url <url>` parses and canonicalizes the requested URL. It does not use the file-oriented readable-input resolver.
2. The CLI selects a plugin with `ingest-url`, invokes it through the existing isolated plugin runner, validates returned artifacts through the host, and hands them to a generalized source-artifact publisher.
3. The publisher requires exactly one `original` and one `normalized` artifact, validates the normalized metadata, persists source provenance, and derives a stable dedupe key from canonical URL plus fixed ingestion options. It supports source-specific original naming instead of deriving a basename from `input.filePath`.
4. The plugin returns:
   - one original response body, preserving its safe media type and a deterministic filename;
   - one `content.md` normalized artifact with metadata `{ canonicalUri, extractor: 'source-url', format: 'markdown', extractionStatus, warnings }`.

## Request safety policy

The plugin owns one request helper. It must validate the initial URL and every redirect target before connecting:

- only `http:` and `https:`; no credentials, fragment, malformed host, or explicit non-default local service endpoint;
- at most 5 redirects; redirect loops or a redirect without a valid `Location` fail closed;
- DNS lookup checks every returned address and rejects loopback, unspecified, private, link-local, multicast, and IPv6 local/unique-local ranges;
- the actual connection uses the validated address/host pair so a fresh resolver lookup cannot bypass validation; TLS SNI and certificate verification remain enabled for HTTPS;
- maximum response payload is 5 MiB, enforced during streaming, not only from `Content-Length`;
- accepted content types are HTML/XHTML and plain text/Markdown. Unsupported, missing, or deceptive content type fails with an explicit source-url error;
- diagnostics retain the canonical URL but redact query and fragment values from user-visible errors and warnings.

## Normalization

- HTML/XHTML is normalized to Markdown through a deterministic converter. Script, style, template, noscript, and comments are omitted; document title becomes optional front matter/heading only when present.
- Plain text and Markdown are UTF-8 decoded and normalized without HTML parsing.
- Invalid charset, empty usable content, or conversion degradation emits a deterministic warning and uses `extractionStatus: 'gap'`; unsafe or unreadable responses fail rather than returning partial binary data.

## Integration boundaries

- Add the `source.url` contract JSON and include it in plugin-contract verification.
- Generalize only the publisher interface needed to accept a URL origin; retain the existing file ingestion behavior and artifact rules.
- Add no release/sign/tag/catalog operation. Existing official artifact staging includes the built `source.url` package automatically.

## Tests and acceptance

- Unit tests cover URL parsing/canonicalization, forbidden schemes/credentials, every blocked address family, redirect revalidation/loop/limit, streaming body limit, content-type checks, and query redaction.
- Plugin tests use a local controlled HTTP fixture with an injectable resolver/dispatcher; they prove returned original/normalized artifacts and metadata without calling external sites.
- CLI integration tests verify capability selection, URL publication, stable dedupe, and explicit error mapping.
- Existing file ingestion behavior remains green; `source.youtube` remains a non-ingesting scaffold.
