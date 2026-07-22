# OCR Runtime Dependency License Inventory Design

## Goal

Make every native OCR runtime artifact publishable only when every bundled non-system
library has a complete, immutable source and license record.

## Problem

The current Windows and macOS builders discover dynamic dependencies correctly, but try to
read license files from MSYS2 and Homebrew installation layouts. Those package-manager
installations do not guarantee that upstream license text is present. The result is a
correct fail-closed build that cannot complete for valid dependencies such as `giflib` and
`leptonica`.

## Approved Approach

Add a repository-owned dependency inventory. Every entry is keyed by the package-manager
provider and exact installed version and contains:

- provider identity (`msys2` or `homebrew`), package/formula name, and version;
- immutable HTTPS source archive URL and its SHA-256;
- path of the license file inside that archive and the SHA-256 of the extracted text;
- SPDX identifier for human-readable attribution.

The builders retain their existing runtime dependency traversal. For each copied library,
they resolve its provider and version, look up exactly one inventory entry, download and
verify the source archive, extract only the declared license path, verify the license hash,
and append the raw license text to `THIRD_PARTY_NOTICES`.

An unknown provider, a version mismatch, a bad archive hash, a missing license path, or a
bad license-text hash is `OCR_RUNTIME_NOTICES_INVALID` and blocks artifact upload.

## Data Flow

```text
runtime executable
  -> platform dependency traversal
  -> copied private library + provider/version
  -> immutable inventory lookup
  -> verified source archive + verified license text
  -> THIRD_PARTY_NOTICES
  -> runtime health check and artifact upload
```

Windows obtains the provider with `pacman -Qo` and its installed version with `pacman -Q`.
macOS obtains the provider with `brew which-formula` and its installed version with
`brew info --json=v2 --installed`. Both emit the provider, version, copied library names,
source URL/SHA, license path/SHA, SPDX identifier, and raw text in notices.

## Scope

- Include only libraries actually discovered by the executable dependency traversal.
- Inventory entries are exact-version entries; a package-manager update introduces a
  deliberate failure until its new sources and license hashes are reviewed and recorded.
- Keep the existing Tesseract and tessdata source records unchanged.
- Do not publish a release or relax the notice requirement.

## Verification

- Unit tests validate that inventory entries have HTTPS URLs, versions, SHA-256 values, and
  non-empty license paths.
- Builder tests assert that both native builders use the inventory rather than package-manager
  documentation directories.
- A workflow dispatch must produce all four artifacts, each with non-empty notices and a
  successful `--list-langs` health check, before a tag-based release is considered.
