# Copilot nits and HTML help polish

> Build this with **tlc-implement**.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Copilot leftovers from PR #17 and deferred HTML-help polish from PR #27 are still in the tree.
Users get a Grok auth recovery that does not name the documented recovery; `--html` accepts any
topic string; Instagram copy-paste examples force `--stt`; ADR-004 still says only Codex and
Claude; `serveMcp` JSDoc omits Grok; the web client imports a Node runtime type; profile ids
and the profile table can drift.

When this ships, those copy and constraint gaps match the Copilot findings and the PR #27 notes.

8 criteria in 1 slice · 0 one-way doors · 0 open, of which 0 block

Sizing evidence: user asked for this cleanup as one PR; CONTRIBUTING has no task-size rule.

## Criteria

1. Given Grok is available and `authenticated: false`, when `sheldon agent doctor grok` runs,
   then stdout contains `grok login` and `XAI_API_KEY` and does not contain a secret value from
   the parent env. Codex/Claude unauthenticated recovery stays `sign in with <executable>`.
2. Always, the `serveMcp` docblock names Grok alongside Codex and Claude as a consumer of the
   local stdio server.
3. Always, `apps/web/src/App.tsx` does not import `@sheldon/agent-runtime`; the query agent
   control still offers `codex`, `claude`, and `grok`.
4. Always, ADR-004 states Codex CLI, Claude Code, and Grok CLI as workers and points at
   ADR-015 for the profile registry; it still says Sheldon does not call model APIs.
5. Always, `AGENT_PROFILE_IDS` is derived from the profile table (same order as
   `listAgentProfiles().map((p) => p.id)`).
6. When `sheldon help --path --html` runs, then stdout is the help root, exit 0, and the
   browser opener is not called.
7. When `sheldon help --html` is given a topic that is not a manifest page id (including
   `../secret` and an unknown token), then exit 1, stderr contains `HELP_PAGE_MISSING`, and
   the opener is not called. Manifest ids such as `init` still open.
8. Always, the Instagram Reel examples in `apps/cli/help/pages/ingest.md` do not include
   `--stt`; `--stt` remains documented as optional in the flags list.

## Out of scope

- Real `agentVersion` detection - named as its own slice in the Grok spec
- npm release / emptying Unreleased
- Changing `JsonCommandExecutor` env rules
- Importing `@sheldon/agent-runtime` into the web client (Copilot forbids it)

## Observable

| Surface                               | Decision                          | Landing |
| ------------------------------------- | --------------------------------- | ------- |
| command `sheldon agent doctor`        | unauthenticated recovery copy     | 1       |
| command `sheldon help --path/--html`  | flags and combined default        | 6       |
| command `sheldon help --html [topic]` | error shape `HELP_PAGE_MISSING`   | 7       |
| command `sheldon help --html [topic]` | unknown / traversal topic         | 7       |
| document ADR-004                      | structure and next step           | 4       |
| document ingest HTML help             | Instagram example                 | 8       |
| screen query agent select             | options `codex`, `claude`, `grok` | 3       |
| collection agent profile ids          | grouping from the table           | 5       |

## Swept

- validation: 7
- failure modes: 7
- idempotency and retry: n/a - no writes
- authorization: n/a - local CLI
- concurrency and ordering: n/a - no shared mutation
- data lifecycle: n/a
- external-dependency failure: existing - HELP_PAGE_MISSING already used
- state transitions: n/a
- observability: 1 - recovery names the documented Grok auth paths, never secret values

## Impact

| Front       | What changes       |
| ----------- | ------------------ |
| domain      | nothing            |
| stored data | nothing to migrate |

## Decided

| Decision                         | Shape                                                                            | Alternative rejected                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Web agent union stays local      | `'codex' \| 'claude' \| 'grok'` in `App.tsx`, no `@sheldon/agent-runtime` import | `listAgentProfiles()` in the client - Copilot forbids coupling the browser module to the Node runtime package |
| `--html` topics are manifest ids | `^[a-z0-9]+(?:-[a-z0-9]+)*$` and id ∈ `manifest.pages[].id`                      | any string that happens to have a file under `pages/` — path traversal and stray files                        |

## Sources

- conversation - user delegated cleanup of Copilot PR #17 nits plus PR #27 HTML help polish
- Copilot review on PR #17 - Grok recovery, `serveMcp` JSDoc, App.tsx import, ADR-004, profile ids
- PR #27 notes - `--path` over `--html`, constrain HTML topics, Instagram `--stt` optional

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
