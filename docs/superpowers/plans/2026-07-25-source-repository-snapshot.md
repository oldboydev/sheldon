# Source Repository Snapshot Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task-by-task with a fresh implementer and read-only review gate.

**Goal:** Ingest a clean local Git HEAD snapshot through source.repository.

**Architecture:** A Git adapter supplies immutable tree/blob data; snapshot and secret modules make bounded deterministic selection; an official plugin publishes declared artifacts through the existing source publisher.

**Tech Stack:** Node.js 24, TypeScript, Vitest, user-installed Git.

## Global Constraints

- Local non-symlink Git worktree only; every checked-out regular file must be byte-for-byte identical to committed HEAD. No Git status/filter conversion, clone/fetch/remote/authentication/network/hooks/shell; raw differences caused by `autocrlf`/`eol`/custom-filter checkout conversion and submodules are rejected, while inactive custom-filter configuration alone is not.
- Bound raw validation separately to 64 MiB and 10,000 directory entries; report validation exhaustion as `REPOSITORY_GIT_OUTPUT_LIMIT`, not a dirty worktree.
- Snapshot HEAD blobs, not working-tree files; deterministic tree order and independently bounded selected bytes.
- One original.commit.json, one content.md, and inventory asset; selected secret blocks all publication.
- Keep OCR/release/catalog/task-4-report untouched; no push.

### Task 1: Git boundary and deterministic snapshot

Files: create source.repository git.ts/snapshot.ts tests.

- [ ] Write failing injected-runner tests for worktree/HEAD validation, raw byte-for-byte checkout rejection (including conversion), tracked tree order, HEAD blob reads, and no-shell/no-network arguments.
- [ ] Implement typed GitRunner commands with fixed no-config environment, canonical local URI, commit/tree metadata, strict raw checkout validation without Git status/filter conversion, streamed traversal with fixed raw-byte/directory-entry budgets, stable path validation, text/binary classification, and separate fixed selection file/per-file/aggregate limits.
- [ ] Run focused tests, typecheck, lint; commit feat(repository): snapshot committed Git trees.

### Task 2: Secret refusal and Markdown/inventory normalization

Files: create secrets.ts/normalize.ts tests.

- [ ] Write failing tests for high-signal fixture secrets, no value disclosure, ignored/binary/oversize inventory, deterministic Markdown fencing, and stable warnings.
- [ ] Implement pre-materialization scans and deterministic selection inventory; REPOSITORY_SECRET_DETECTED fails before artifacts.
- [ ] Run focused tests, typecheck, lint; commit feat(repository): block secrets in snapshots.

### Task 3: Official plugin, package contract, and release plumbing

Files: create source.repository package/manifest/entrypoint/plugin/tests/contract; modify build, contract verifier, official artifact static lists/tests as required.

- [ ] Write failing plugin/health/contract tests: git dependency, no network permissions, exact artifacts and metadata, missing-git remediation.
- [ ] Compose Git snapshot and secret units; materialize hashes/sizes; add source.repository to build, contract and official package enumerations without release/sign/catalog-version operations.
- [ ] Run focused plugin/release/contract tests; commit feat(repository): add official snapshot connector.

### Task 4: CLI publication and public documentation

Files: modify CLI memory/main; add repository-ingestion acceptance; modify README, roadmap, changelog.

- [ ] Write failing CLI tests for capability selection, successful publication/dedupe/revision, secret pre-publication failure, and explicit plugin override.
- [ ] Add ingest repository command; pass only fixed options; document local clean snapshot scope and pending remote/crawl work.
- [ ] Run CLI/source tests, build, contracts; commit feat(cli): ingest local Git repositories.

### Task 5: Independent final review and gates

- [ ] Run focused repository/CLI/host tests plus format, lint, typecheck, markdown, build, contracts, domain/repo checks, and diff check.
- [ ] Dispatch a whole-feature reviewer for Git execution, path containment, secret refusal, publication metadata, and accidental release/OCR scope.
- [ ] Fix all Critical/Important findings, rerun gates, and record completion.
