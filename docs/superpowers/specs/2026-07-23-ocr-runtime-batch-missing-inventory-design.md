# OCR Runtime Batch Missing Inventory Design

## Goal

Make each native OCR runtime build enumerate every discovered package/version that lacks a pinned notice record, then fail once with the complete sorted list. The inventory remains manually authored from verified primary-source artifacts and license texts.

## Scope

- Windows/MSYS2 and macOS/Homebrew native builders only.
- Preserve the existing fail-closed behavior for malformed inventory records, bad source hashes, absent license texts, and license hash mismatches.
- Do not generate or publish notice records automatically.

## Design

Both builders already discover a complete set of private runtime libraries before writing notices. They will separate this discovery phase from notice materialization:

1. Resolve all package identities, de-duplicate them by provider/name/version, and emit the existing `OCR_RUNTIME_DEPENDENCY` diagnostic for every identity.
2. Look up every identity against the pinned inventory without downloading any notice source yet.
3. Collect identities with no record and, after the full scan, fail with one deterministic `OCR_RUNTIME_MISSING_DEPENDENCIES` block containing sorted `provider/name@version` lines.
4. Only when the missing set is empty, download each pinned source archive and verify/render all `licenses[]` entries exactly as today.

The inventory module will expose a non-throwing exact lookup for the builders' batch phase. Its existing throwing lookup stays available for callers that require a record immediately.

## Error Handling

- Missing records: one complete batch diagnostic, exit non-zero before any notice download.
- Invalid inventory shape: `OCR_RUNTIME_NOTICES_INVALID`, fail immediately.
- A record present but invalid, a source mismatch, or a license mismatch: preserve the existing fail-closed error.
- Output order: lexical by provider, name, then version, so CI logs are stable and easily machine-readable.

## Tests

- Inventory tests cover non-throwing exact lookup and deterministic missing-identity formatting.
- Windows and macOS builder harnesses cover several missing entries and assert that the full set appears before failure.
- Existing tests continue to prove valid records render all license texts and invalid records fail closed.

## Acceptance Criteria

- A CI run lists all missing Windows/MSYS2 and macOS/Homebrew identities from its discovered private runtime graph in one attempt.
- No missing entry is silently ignored or auto-generated.
- A complete inventory still produces exactly the same verified notices and runtime artifact behavior.
