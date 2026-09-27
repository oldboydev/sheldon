# Sanitize LocalAgentHealthProbe environment

> Build this with **tlc-implement**.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

`sheldon agent doctor` spawns local agent CLIs (`grok --version`, `codex login status`,
`claude auth status`) with the full parent environment. `JsonCommandExecutor` already
sanitizes the child env. Anyone with a secret in the parent env (`SECRET_TOKEN`, tokens,
keys that are not on the profile allowlist) leaks that secret into the health-check child.
The issue gives no volume figure; the leak is the evidence.

When this ships, the doctor spawn uses the same child env as the executor: shared base keys
plus `profile.envAllowlist`. Doctor still reports available/authenticated when the probe
would have succeeded. Secret values do not appear in doctor stdout/stderr.

4 criteria in 1 slice · 1 one-way door · 0 open, of which 0 block

Sizing evidence: `CONTRIBUTING.md` does not declare task size; GitHub issue #18 is one
issue; default is one task.

## Criteria

### Health-check spawn uses the executor child-env rule

1. Given a parent env that contains `SECRET_TOKEN` and a health-check executable that exits
   non-zero when that key is present in the child env, when `LocalAgentHealthProbe.check`
   runs for `codex`, `claude`, and `grok`, then each result has `available: true`.
2. Given `HOME` or `USERPROFILE` in the parent, and for `grok` also a non-empty
   `XAI_API_KEY` or `GROK_HOME` with `auth.json`, when the probe would have succeeded, then
   `sheldon agent doctor` reports each of `codex`, `claude`, and `grok` as available and
   Authentication `usable`. Codex/Claude authentication commands still see home/temp keys
   even though those profiles have `envAllowlist: []`. Grok authentication still reads
   `XAI_API_KEY` / `GROK_HOME` from the parent; the `--version` spawn still receives those
   allowlist keys.
3. When `sheldon agent doctor` runs with `SECRET_TOKEN` in the parent env, then stdout and
   stderr do not contain that token value.
4. Always, the health-check child env is `buildChildEnvironment(parent, profile.envAllowlist)`
   exported from `@sheldon/agent-runtime`: `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`,
   `LANG`, `LANGUAGE`, `LC_*`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TMP`,
   `TEMP`, plus the profile allowlist (`[]` for Codex and Claude; `GROK_HOME` and
   `XAI_API_KEY` for Grok). It is not the full parent env and not `envAllowlist` alone.

## Out of scope

- Copy nits from the Copilot pass on PR #17 (Grok recovery text mentioning `XAI_API_KEY`,
  `serveMcp` JSDoc, ADR-004 vs ADR-015, deriving `AGENT_PROFILE_IDS` from the profile table,
  local agent union in `App.tsx`) - the issue tracks those separately
- Changing `JsonCommandExecutor` sanitization rules - already the source of the rule
- Printing or logging child env keys

## Observable

| Surface                                | Decision                        | Landing                                                                    |
| -------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| command `sheldon agent doctor [agent]` | output format                   | existing - available/not found plus Authentication usable/unavailable      |
| command `sheldon agent doctor [agent]` | empty / missing binary          | existing - `not found` plus recovery                                       |
| command `sheldon agent doctor [agent]` | error / timeout / spawn failure | existing - treated as unavailable                                          |
| command `sheldon agent doctor [agent]` | flags and defaults              | existing - optional `agent` (`codex`, `claude`, or `grok`)                 |
| command `sheldon agent doctor [agent]` | exit codes                      | existing - exit 0 even when an agent is missing                            |
| command `sheldon agent doctor [agent]` | failure halfway                 | existing - per-agent report, others still printed                          |
| command `sheldon agent doctor [agent]` | verbosity                       | existing - version string when captured; secrets omitted (3)               |
| API `buildChildEnvironment`            | error shape and codes           | n/a - pure function, no throw contract                                     |
| API `buildChildEnvironment`            | who may call                    | existing workspace consumers of `@sheldon/agent-runtime` (private package) |
| API `buildChildEnvironment`            | versioning                      | n/a - package is `"private": true`, not a published public API             |

## Swept

- validation: n/a - no new user input
- failure modes: existing - spawn error and non-zero exit already map to `available: false`
- idempotency and retry: n/a - doctor is a read-only probe with no write and no retry
- authorization: n/a - local CLI, no caller identity
- concurrency and ordering: existing - `Promise.all` over profiles, reports printed in
  profile-table order
- data lifecycle: n/a - nothing stored
- external-dependency failure: existing - missing binary / timeout already surface as
  `not found`
- state transitions: n/a - no lifecycle change
- observability: 3

## Impact

| Front       | What changes                         |
| ----------- | ------------------------------------ |
| domain      | nothing - no term added or redefined |
| stored data | nothing to migrate                   |

`LocalAgentHealthProbe.check(agent, environment)` keeps its signature. Callers of
`AgentHealthProbe` are unchanged. `JsonCommandExecutor` keeps calling the same function;
the CLI doctor path starts calling it too.

## Decided

| Decision                                                    | Shape                                                                                                                                                                        | Alternative rejected                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse `buildChildEnvironment` from `@sheldon/agent-runtime` | export `buildChildEnvironment(source: NodeJS.ProcessEnv, allowlist: readonly string[]): NodeJS.ProcessEnv` — the function `JsonCommandExecutor` already uses                 | copy the key lists into `apps/cli` — two lists would drift                                                                                        |
| Health-check child env                                      | base keys (`PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`, `LANG`, `LANGUAGE`, `LC_*`, `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TMP`, `TEMP`) plus `profile.envAllowlist` | pass only `envAllowlist` — Codex and Claude have `[]` and still need home/temp for `login`/`auth status`; pass the full parent — that is the leak |

## Surface

| Route                                      | In                                                                     | Out                                                                     | Status | Criteria |
| ------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ | -------- |
| `sheldon agent doctor [agent]`             | optional `agent` (`codex` \| `claude` \| `grok`), parent `environment` | per-agent lines: available/not found, Authentication usable/unavailable | exit 0 | 2, 3     |
| `buildChildEnvironment(source, allowlist)` | `NodeJS.ProcessEnv`, `readonly string[]`                               | `NodeJS.ProcessEnv`                                                     | n/a    | 4        |

## Sources

- [issue #18](https://github.com/oldboydev/sheldon/issues/18) - sanitise doctor spawn like
  the executor; tests; out of scope copy nits
- `docs/superpowers/specs/2026-09-16-agent-registry-and-grok-design.md` - executor child-env
  rule (base keys plus `envAllowlist`; `SECRET_TOKEN` not forwarded)
- conversation - user delegated plan-and-implement for the single open issue

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
