# Source repository committed-snapshot design

## Goal

Add the optional official source.repository connector and sheldon ingest repository command for a reproducible local Git snapshot. It publishes one commit-metadata original, deterministic Markdown from selected tracked text/code files, and a selection inventory, without network access.

## Scope

- Accept only a readable, non-symlink local Git worktree with a resolved HEAD whose checked-out regular files are byte-for-byte identical to the committed HEAD tree. Git worktree-aware status or filter conversion is not used. Inactive custom-filter configuration is neither executed nor rejected by itself; only a checkout conversion or other raw difference from the HEAD blob is unsupported.
- Use a user-installed git executable with a no-network fixed command boundary.
- Before filesystem traversal, reject a HEAD whose raw regular files exceed 64 MiB or whose expected checkout inventory exceeds 10,000 directory entries. Stream actual entries under the same global entry budget and report exhaustion as `REPOSITORY_GIT_OUTPUT_LIMIT`, never as a dirty-worktree result.
- Separately enumerate HEAD-tracked paths in Git tree order, read blobs from HEAD rather than the working directory, and apply the selection limits of 500 candidate files, 1 MiB per file, 10 MiB aggregate candidate bytes, and fixed text/code extensions.
- Preserve commit SHA, tree SHA, canonical file URI, and selected/skipped inventory. Emit original.commit.json, content.md, and tree.json asset.
- Scan every selected blob before artifact materialization. A detected secret fails with REPOSITORY_SECRET_DETECTED and publishes nothing; diagnostics never disclose the value.
- Support only local committed snapshots in this slice. Clone URLs, authentication, submodules, LFS, worktrees with checkout conversion or any byte difference from HEAD, checkpoints, alternate ignore rules, and compression are deferred.

## Alternatives

1. Add repository support to source.file. This conflicts with the existing regular-file input contract and leaks Git mechanics into a generic extractor.
2. Clone URLs directly in the CLI. This introduces authentication, network, and secret surfaces before the first reproducible local proof.
3. Add source.repository with ingest-repository and a dedicated command. It isolates Git policy and reuses existing plugin publication.

Approach 3 is selected.

## Architecture

git.ts owns injected command execution, strict raw-worktree validation, HEAD/tree inspection, tracked-path enumeration, and blob reads. It preflights the global validation byte/expected-entry budgets, streams directory entries under the same entry budget, compares raw regular-file bytes with the committed blob identities, and rejects extra, missing, symlinked, converted, or otherwise different checkout entries without invoking Git status or filters. snapshot.ts independently applies deterministic selection limits/classification and creates the inventory. secrets.ts scans selected bytes using fixed high-signal patterns and reports only path/category. plugin.ts composes these units, materializes host-validated artifacts, and exposes healthcheck for git --version. The CLI selects ingest-repository and calls the existing generic publisher.

## Safety and tests

Git is always launched without a shell, with GIT_CONFIG_NOSYSTEM and a private no-config environment. No clone, fetch, remote, hook, filter, or external command is allowed. Tests use temporary repositories and an injected runner: clean deterministic snapshot, raw-byte dirty/conversion refusal, missing Git refusal, ignored/binary/oversize inventory, secret pre-publication refusal, content dedupe, revision linkage, healthcheck, plugin contract, and CLI publication.

## Autonomous approval

The active goal requires autonomous completion of connectors. This bounded local-snapshot design is approved; it is a complete repository connector slice while larger remote and crawl capabilities remain explicitly separate connector work.
