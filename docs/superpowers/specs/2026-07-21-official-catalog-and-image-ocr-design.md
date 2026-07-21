# Official Catalog and Image OCR Design

## Goal

Make official Sheldon plugins optional and installable from a verified GitHub catalog, while delivering image ingestion through a single visible `source.image` plugin that embeds Tesseract plus Portuguese and English OCR models.

## Scope

This design replaces the current bundled `sheldon.file` OCR behavior with two independently installable source plugins:

- `source.file` ingests local text, document, archive, and structured-data formats. It does not claim images.
- `source.image` ingests local image formats and owns OCR. Its internal Tesseract runtime is not a discoverable or installable plugin.

The official catalog and every official plugin artifact are published through [oldboydev/sheldon](https://github.com/oldboydev/sheldon) GitHub Releases.

## User Experience

The local command reports only locally installed plugins:

```powershell
sheldon plugin list
```

The remote variant explicitly reaches GitHub, verifies the official catalog, and shows every official plugin together with the local installation state:

```powershell
sheldon plugin list --remote
sheldon plugin info source.image --remote
```

Installation is an explicit network operation:

```powershell
sheldon plugin install source.file
sheldon plugin install source.image
sheldon plugin install source.url
sheldon plugin install source.youtube
```

`source.image` includes the local OCR engine and `por` plus `eng` models. Image ingestion defaults to `por+eng`; both models are mandatory base data and cannot be removed. Extra models are managed as data owned by `source.image`, not as plugins:

```powershell
sheldon image language list
sheldon image language install deu
sheldon image language remove deu
```

`remove` rejects `por` and `eng`. `install` accepts only catalog-defined language codes; it never accepts an arbitrary URL or filesystem path.

## Official Catalog

The desktop/CLI distribution embeds an Ed25519 public key. `sheldon plugin list --remote`, `plugin info --remote`, `plugin install`, and `image language install` download the current `catalog.json` and detached `catalog.sig` from the `official-catalog` release in `oldboydev/sheldon`. The client accepts a catalog only when the detached signature validates against the embedded key.

The catalog has schema version `1`, a monotonically increasing `publishedAt` timestamp, and these immutable records:

```ts
interface OfficialPluginCatalogEntry {
  readonly id: string; // lowercase dot-separated identifier, for example source.image
  readonly version: string;
  readonly platforms: readonly ('win32-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64')[];
  readonly artifacts: Readonly<Record<string, { url: string; sha256: string; bytes: number }>>;
  readonly description: string;
}

interface OfficialLanguageCatalogEntry {
  readonly owner: 'source.image';
  readonly code: string;
  readonly artifacts: Readonly<Record<string, { url: string; sha256: string; bytes: number }>>;
}
```

Every artifact URL must be HTTPS and point to a GitHub Release asset under `https://github.com/oldboydev/sheldon/releases/download/`. The client rejects other hosts, an unknown schema, duplicate IDs/codes, unsupported platforms, malformed hashes, signature failures, oversized downloads, and byte-count/hash mismatches.

The release process produces platform-specific plugin archives, `catalog.json`, its detached signature, an SBOM, and `THIRD_PARTY_NOTICES`. The matching public key is compiled into the CLI before release; the signing private key never enters a package or repository checkout.

## Installation and Storage

Official plugin installation uses the existing local plugin registry and its locking/staging guarantees. The catalog client downloads an artifact into a private temporary directory, verifies the exact byte count and SHA-256, extracts only regular files under the temporary root, validates the embedded plugin manifest, and calls the registry's existing atomic install path. Nothing is executed during download or installation.

`plugin list` reads the local registry and never contacts the network. `plugin list --remote` does not install or persist a plugin; it combines the verified remote catalog with local registry records to show `installed` or `not installed`. `plugin info` is local by default and requires `--remote` for an entry that is not installed.

The image plugin stores language data below its own registered local directory at `data/tessdata/`. Language installation stages a single verified `.traineddata` file, atomically renames it into that directory, and writes a small local language registry containing code, catalog version, SHA-256, bytes, and installation timestamp. It never modifies operating-system Tesseract locations or the user `PATH`.

## Image OCR Runtime

Each `source.image` archive contains exactly the platform-specific Tesseract executable, its third-party runtime libraries, `data/tessdata/por.traineddata`, `data/tessdata/eng.traineddata`, license notices, and the plugin protocol executable. The plugin runs its packaged executable with `shell: false`, a private temporary image file, `--tessdata-dir` pointing at its own data directory, and `-l por+eng` by default.

The plugin may accept a caller-provided language selection only when every `+`-separated code is present in its local language registry. Missing languages fail before launching OCR with the stable `IMAGE_LANGUAGE_NOT_INSTALLED` diagnostic and remediation `Run sheldon image language install <code>.` A corrupted or missing packaged base model is an unhealthy `source.image` doctor check and blocks OCR.

## Network Policy

The catalog and language commands use the network only because the user explicitly requested them. `plugin install` similarly uses the network only for the requested official artifact. This is separate from source ingestion: an installed source plugin may use network access during a user-initiated ingestion only when its manifest declares `network: true`. `source.file` and `source.image` remain offline during ingest; `source.url` and `source.youtube` may declare network access.

## Failure Handling

- Catalog download, signature, schema, host, size, hash, or archive validation failures leave no installed plugin or language data behind.
- Duplicate plugin IDs and duplicate language codes are rejected without replacement.
- Removing a base language returns `IMAGE_LANGUAGE_REQUIRED`.
- Removing a language that is not installed returns `IMAGE_LANGUAGE_NOT_INSTALLED`.
- If an installed plugin's manifest or digest no longer matches its registry record, normal discovery diagnostics remain authoritative and installation does not overwrite it.
- A failed language replacement preserves the previously installed model.

## Testing and Verification

Tests use injected fetch, signature verification, archive extraction, platform identity, clock, and temporary-root dependencies; they never access GitHub or download Tesseract during test execution. They cover valid signed catalogs, hostile catalog entries, checksum and size failures, archive path escapes, interrupted staging, local-vs-remote list behavior, plugin-platform selection, base-model immutability, explicit language installation/removal, `por+eng` invocation, and source selection in which image files are claimed only by `source.image`.

The release artifact verification runs against every supported platform archive, checks notices/SBOM presence, validates the manifest and package digest, and ensures the `source.image` runtime starts with its packaged `--tessdata-dir` rather than the system installation.

## Out of Scope

- Arbitrary third-party catalog URLs and arbitrary model URLs.
- Silent plugin or language downloads during ingest.
- Automatically installing dependencies from npm, pip, Homebrew, or an operating-system package manager.
- A visible `ocr.tesseract` plugin.
- Language-model training or a Brazil-specific `pt-BR` model; the official Portuguese model code is `por`.
