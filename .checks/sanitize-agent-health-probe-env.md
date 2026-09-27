# Sanitize LocalAgentHealthProbe environment

Sources:

- [issue #18](https://github.com/oldboydev/sheldon/issues/18) - doctor spawn sanitization,
  tests, out of scope
- `.tasks/sanitize-agent-health-probe-env.md` - criteria 1–4, doors, sweep landings
- `docs/superpowers/specs/2026-09-16-agent-registry-and-grok-design.md` - executor child-env
  rule (base keys plus `envAllowlist`)

Profile: `light` (no `AGENTS.md` declaration). Handoff: one slice, under budget, no split.

## Out of scope

- Copy nits from the Copilot pass on PR #17 - issue #18 tracks those separately
- Changing `JsonCommandExecutor` sanitization rules
- Printing or logging child env keys

## Landing

`packages/agent-runtime` exports the existing `buildChildEnvironment`. `LocalAgentHealthProbe`
in `apps/cli/src/commands/agents.ts` uses it on spawn instead of passing the parent env.
Tests reuse the Grok executor fixture idea: a child that exits non-zero if `SECRET_TOKEN` is
present.

| One-way door                                                 | Literal shape                                                                                                                                           | Alternative rejected                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Export `buildChildEnvironment` from `@sheldon/agent-runtime` | `buildChildEnvironment(source: NodeJS.ProcessEnv, allowlist: readonly string[]): NodeJS.ProcessEnv` — same function `JsonCommandExecutor` already calls | copy the key lists into `apps/cli` — two lists would drift                      |
| Health-check child env                                       | base keys plus `profile.envAllowlist`                                                                                                                   | allowlist only (Codex/Claude `[]` would drop home/temp); full parent (the leak) |
| `LocalAgentHealthProbe` executable override                  | `Pick<JsonCommandExecutorOptions, 'executables'>`, same shape as the executor fixture                                                                   | PATH wrappers per agent name — fragile on Windows `PATHEXT`                     |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Health-check spawn uses the executor child-env rule · 6 files · ~28 KB · ~7k

**C1** - `LocalAgentHealthProbe.check` reports `available: true` for `codex`, `claude`, and
`grok` when the parent env has `SECRET_TOKEN` and the child executable exits non-zero if
that key is present
Proof: `npx vitest run apps/cli/test/agents.test.ts -t "does not forward SECRET_TOKEN to health-check children"`

**C2** - `sheldon agent doctor` reports Codex, Claude, and Grok as available with
Authentication `usable` when home keys are in the parent (and for Grok, `XAI_API_KEY` or
`GROK_HOME`); Codex/Claude auth still sees home keys despite empty allowlists
Proof: `npx vitest run apps/cli/test/agents.test.ts -t "reports fixture agents available and authenticated without printing secrets"`

**C3** - `sheldon agent doctor` stdout and stderr omit the parent `SECRET_TOKEN` value
Proof: `npx vitest run apps/cli/test/agents.test.ts -t "reports fixture agents available and authenticated without printing secrets"`

**C4** - `buildChildEnvironment(parent, allowlist)` copies only `PATH`, `PATHEXT`,
`SystemRoot`, `WINDIR`, `LANG`, `LANGUAGE`, `LC_*`, `HOME`, `USERPROFILE`, `HOMEDRIVE`,
`HOMEPATH`, `TMP`, `TEMP`, plus the allowlist keys that are set, and never `SECRET_TOKEN`;
it is exported from `@sheldon/agent-runtime`
Proof: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts -t "buildChildEnvironment forwards base keys and allowlist without secrets"`

## Swept

- validation: n/a - no new user input
- failure modes: existing - spawn error and non-zero exit already map to `available: false`
- idempotency and retry: n/a - read-only probe
- authorization: n/a - local CLI
- concurrency and ordering: existing - `Promise.all` over profiles, print in table order
- data lifecycle: n/a - nothing stored
- external-dependency failure: existing - missing binary / timeout already `not found`
- state transitions: n/a
- observability: C3

## Handoff

S1 ≈ 7k tokens of reading (`agents.ts`, `command-executor.ts`, `index.ts`, `agents.test.ts`,
`agent-runtime.test.ts`, fixture). Under 150k. No split.

## Coverage

| Set (size)                      | Member -> proof                                                                                    | Unproven |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| agent kinds on doctor spawn (3) | `codex` C1 · `claude` C1 · `grok` C1; available+auth C2                                            | -        |
| child-env key groups (3)        | base keys C4 · Codex/Claude empty allowlist still gets home C2 · Grok `GROK_HOME`/`XAI_API_KEY` C4 | -        |
| secret leak surfaces (2)        | child env C1 · doctor stdout/stderr C3                                                             | -        |

- Claims naming a status code, route or response shape: none
- No other check claims more than the single case its proof exercises
