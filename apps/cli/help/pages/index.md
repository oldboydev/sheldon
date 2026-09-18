# Sheldon help

Offline HTML help for the Sheldon CLI. Terminal `--help` stays short; these pages add examples and flows.

## Flows

- [First vault](pages/flow-first-vault.html) — create a vault and save it as the local default
- [Compile then review](pages/flow-compile-review.html) — raw capture → compile → preview → approve
- [End-to-end](pages/flow-end-to-end.html) — init → ingest → compile → approve → search / query

## Commands

- [init](pages/init.html) — create a vault
- [doctor](pages/doctor.html) — check vault, plugins, and agents
- [migrate-state](pages/migrate-state.html) — copy legacy application state
- [web](pages/web.html) — local loopback web UI
- [topic](pages/topic.html) — create and manage topics
- [project](pages/project.html) — create and manage projects
- [ingest](pages/ingest.html) — capture sources into immutable raws
- [compile](pages/compile.html) — turn raws into reviewable proposals (`compile` / `compile-retry`)
- [review](pages/review.html) — preview, approve, reject, and lint proposals
- [bundle](pages/bundle.html) — portable OKF bundles from approved concepts
- [search](pages/search.html) — search approved wiki concepts
- [query](pages/query.html) — ask an agent a cited question from the index
- [answer](pages/answer.html) — promote a saved answer into a proposal
- [agent](pages/agent.html) — check Codex, Claude, and Grok CLIs
- [mcp](pages/mcp.html) — scoped MCP access for consumer projects
- [plugin](pages/plugin.html) — discover and install source plugins
- [image](pages/image.html) — manage OCR language data

## Vault paths

Sheldon does **not** list vaults. Use the default saved by `init`, or pass `--vault <path>` on each command.
