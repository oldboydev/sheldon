# Sheldon help

Offline HTML help for the Sheldon CLI. Terminal `--help` stays short; these pages add examples and flows.

## Flows

- [First vault](pages/flow-first-vault.html) — create a vault and save it as the local default
- [Compile then review](pages/flow-compile-review.html) — raw capture → compile → preview → approve

## Commands

- [init](pages/init.html) — create a vault
- [ingest](pages/ingest.html) — capture sources into immutable raws
- [compile](pages/compile.html) — turn raws into reviewable proposals (`compile` / `compile-retry`)
- [review](pages/review.html) — preview, approve, reject, and lint proposals
- [search](pages/search.html) — search approved wiki concepts
- [query](pages/query.html) — ask an agent a cited question from the index
- [answer](pages/answer.html) — promote a saved answer into a proposal

## Vault paths

Sheldon does **not** list vaults. Use the default saved by `init`, or pass `--vault <path>` on each command.
