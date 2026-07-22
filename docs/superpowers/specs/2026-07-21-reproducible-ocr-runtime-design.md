# Reproducible OCR Runtime Build Design

## Goal

Produce real, redistributable Tesseract runtimes and Portuguese/English models for every
official `source.image` platform archive without committing private keys or opaque third-party
installers to the repository.

## Decisions

- Build Tesseract from the signed upstream `5.5.2` source release and pin the source archive
  SHA-256 in repository-owned build metadata. The build must fail before compilation if it does
  not match.
- Fetch `por.traineddata` and `eng.traineddata` from a pinned commit of the official
  [`tessdata_fast`](https://github.com/tesseract-ocr/tessdata_fast) repository and verify their
  SHA-256 values before staging them.
- Build on native GitHub-hosted runners: Windows x64, Ubuntu x64, macOS Intel, and macOS ARM64.
  Do not cross-compile macOS or redistribute an operating-system package-manager installation.
- Each runner emits one artifact with a fixed layout:

  ```text
  runtime/<platform>/tesseract[.exe]
  runtime/<platform>/lib/<third-party-runtime-files>
  runtime/<platform>/THIRD_PARTY_NOTICES
  data/tessdata/por.traineddata
  data/tessdata/eng.traineddata
  ```

- A runner must execute `tesseract --tessdata-dir <data/tessdata> --list-langs` before uploading
  its artifact. Linux also checks runtime linker dependencies; macOS checks that no Homebrew path
  is embedded; Windows includes every non-system DLL required by the executable.
- Each runtime library is a regular file under the platform's `lib` directory; links and paths
  outside that directory are rejected. The image plugin adds this directory to the child
  Tesseract process's platform loader environment only (`PATH` on Windows, `LD_LIBRARY_PATH` on
  Linux, and `DYLD_FALLBACK_LIBRARY_PATH` on macOS). It never changes the parent environment or
  the user PATH.
- The release workflow downloads all four runtime artifacts into `release/stage/source.image`
  before running the existing deterministic archive builder, catalog signer, and independent
  verifier. A missing, extra, or malformed runtime artifact fails the release before upload.
- The local Docker path mirrors the Ubuntu build only. It is a reproducibility and smoke-test
  tool, not a substitute for native Windows or macOS verification.

## Supply-Chain and License Rules

- The build records source URLs, exact revisions, SHA-256 values, compiler/platform identity,
  and license texts in the generated notices/SBOM.
- Tesseract is Apache-2.0; its image-processing and codec dependencies retain their own notices.
  The runtime artifact may not be published until its notice set is complete.
- The Ed25519 private signing key remains solely in the GitHub Actions secret
  `SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM`. The committed public key is the only key material
  embedded in the CLI.

## Failure Handling and Verification

- A checksum, download, compile, dependency, health-check, or notice failure blocks publication
  and leaves the `official-catalog` release untouched.
- Unit tests validate source-pin parsing, artifact-layout validation, and rejection of missing
  runtime files. The existing release verifier remains the final archive/catalog gate.
- A `workflow_dispatch` dry run builds and validates the runtime artifacts without invoking the
  GitHub Release upload action. Tag pushes remain the only publication path.

## Out of Scope

- Code signing, notarization, or operating-system installers.
- Additional OCR languages beyond the existing catalog-managed language mechanism.
- Using unpinned executables from third-party distribution sites.
