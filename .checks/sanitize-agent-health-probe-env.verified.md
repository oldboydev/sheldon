# Sanitize LocalAgentHealthProbe environment Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: main (`8bdd335920d20f5020ca042a8dca28a2154a5163`)..HEAD (`032c9f934f7e29a467f6922dd6336cacff15d6b4`)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

## Binding sources

Step 1 skipped (profile light; no source marked binding for screens). Sources the brief named were opened so the Checks table is not citing unread artifacts.

| Source                                                                                          | Opened | Contradiction                                             | Uncovered |
| ----------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------- | --------- |
| [issue #18](https://github.com/oldboydev/sheldon/issues/18)                                     | yes    | n/a — step 1 skipped (light)                              | n/a       |
| `.tasks/sanitize-agent-health-probe-env.md`                                                     | yes    | n/a — step 1 skipped (light)                              | n/a       |
| `docs/superpowers/specs/2026-09-16-agent-registry-and-grok-design.md` (executor child-env rule) | yes    | n/a — step 1 skipped (light)                              | n/a       |
| `.checks/sanitize-agent-health-probe-env.md`                                                    | yes    | n/a — the checklist is the contract, not a binding design | n/a       |

## Checks

Named tests exist (`rg`):

- `apps/cli/test/agents.test.ts:77` `it('does not forward SECRET_TOKEN to health-check children'`
- `apps/cli/test/agents.test.ts:86` `it('reports fixture agents available and authenticated without printing secrets'`
- `packages/agent-runtime/test/agent-runtime.test.ts:378` `it('buildChildEnvironment forwards base keys and allowlist without secrets'`

One vitest invocation at HEAD, verbose reporter: those three ran and passed; 34 others skipped.

| Check | Claim                                                                                                                                                                                                                                                    | Proof run                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Result |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1    | `LocalAgentHealthProbe.check` reports `available: true` for `codex`, `claude`, and `grok` when parent env has `SECRET_TOKEN` and the child exits non-zero if that key is present                                                                         | verbose vitest (see Gate) — `agent doctor > does not forward SECRET_TOKEN to health-check children` pass 238ms                    | Precondition `apps/cli/test/agents.test.ts:23` — `SECRET_TOKEN: 'must-not-be-forwarded'`. Assertion `apps/cli/test/agents.test.ts:79-82` — `for (const agent of ['codex', 'claude', 'grok'] as const) { await expect(probe.check(agent, parentEnvWithSecret)).resolves.toMatchObject({ available: true }) }`                                                                                                                                                                                                                                                                                                      | PASS   |
| C2    | `sheldon agent doctor` reports Codex, Claude, and Grok available with Authentication `usable` when home keys are in the parent (and for Grok, `XAI_API_KEY` or `GROK_HOME`); Codex/Claude auth still sees home keys despite empty allowlists             | verbose vitest — `agent doctor > reports fixture agents available and authenticated without printing secrets` pass 104ms          | Precondition `apps/cli/test/agents.test.ts:21-25` — `HOME`, `USERPROFILE`, `XAI_API_KEY`, `GROK_HOME`. Assertions `apps/cli/test/agents.test.ts:92-100` — `expect(result.stdout).toContain('Codex CLI: available (fixture 1.0 home-forwarded xai-missing')`; same for `Claude Code: available (fixture 1.0 home-forwarded xai-missing`; `Grok CLI: available (fixture 1.0 home-forwarded xai-forwarded grok-home-forwarded)`; `expect(result.stdout.match(/Authentication: usable/g)).toHaveLength(3)`                                                                                                            | PASS   |
| C3    | `sheldon agent doctor` stdout and stderr omit the parent `SECRET_TOKEN` value                                                                                                                                                                            | same proof as C2                                                                                                                  | `apps/cli/test/agents.test.ts:23` — value `'must-not-be-forwarded'`. `apps/cli/test/agents.test.ts:91` — `expect(result).toMatchObject({ exitCode: 0, stderr: '' })`. `apps/cli/test/agents.test.ts:101` — `expect(result.stdout).not.toContain('must-not-be-forwarded')`                                                                                                                                                                                                                                                                                                                                         | PASS   |
| C4    | `buildChildEnvironment(parent, allowlist)` copies only PATH, PATHEXT, SystemRoot, WINDIR, LANG, LANGUAGE, LC_*, HOME, USERPROFILE, HOMEDRIVE, HOMEPATH, TMP, TEMP, plus set allowlist keys, never `SECRET_TOKEN`; exported from `@sheldon/agent-runtime` | verbose vitest — `command adapters and runtime > buildChildEnvironment forwards base keys and allowlist without secrets` pass 1ms | Import `packages/agent-runtime/test/agent-runtime.test.ts:16,36` — `buildChildEnvironment` from `../src/index.js` (package barrel; `package.json` `"name": "@sheldon/agent-runtime"`, `"exports": { ".": "./dist/index.js" }`). Assertions `packages/agent-runtime/test/agent-runtime.test.ts:414-423` — `expect(buildChildEnvironment(source, [])).toEqual(base)` (`base` is the listed keys including `LC_ALL`, not `SECRET_TOKEN`); `expect(buildChildEnvironment(source, ['GROK_HOME', 'XAI_API_KEY'])).toEqual({ ...base, GROK_HOME: '/tmp/grok', XAI_API_KEY: 'xai-test' })`; missing allowlist key omitted | PASS   |

### Level / sampling (light)

- C1 names `LocalAgentHealthProbe.check` and the three agent ids; the proof calls `probe.check` for `codex`, `claude`, and `grok`. No sampling gap.
- C2 names the `sheldon agent doctor` CLI surface; the proof is `runCli(['agent', 'doctor'], ...)`. `home-forwarded` plus three `Authentication: usable` lines settle home keys for Codex/Claude; Grok version string settles `XAI_API_KEY` / `GROK_HOME` on the `--version` spawn. No level gap.
- C3 names stdout and stderr at the doctor CLI; both are asserted at that result. Empty `stderr` is stronger than “omits the token” and still targets the claim.
- C4 names the function and the package export. The proof calls the barrel export with exact `toEqual` over the listed keys (LC_* sampled as `LC_ALL`). That is the prefix case, not a nine-to-two under-sample. No check claims more than its proof exercises.

## Swept (`existing` re-read)

n/a rows are policy. `observability: C3` is a check mapping, not an `existing` constraint.

| Row                         | Cited constraint                                        | In code?                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| failure modes               | spawn error and non-zero exit map to `available: false` | yes — `apps/cli/src/commands/agents.ts:83` `if (version.exitCode !== 0) return { available: false, authenticated: false }`; spawn error `agents.ts:147` `finish({ exitCode: null })` (`null !== 0`)                                                            |
| concurrency and ordering    | `Promise.all` over profiles, print in table order       | yes — `agents.ts:36-43` `Promise.all(profiles.map(...))` then sequential `for (const { profile, health } of results)`; `listAgentProfiles()` returns the table in definition order (`profiles.ts:24-112` codex, claude, grok)                                  |
| external-dependency failure | missing binary / timeout already `not found`            | yes — missing binary is the spawn-error path above (`available: false`); timeout `agents.ts:132` `setTimeout(() => child.kill(), 5_000)` then close → non-zero/`null` → `available: false`; doctor print `agents.ts:44-45` `` `${profile.label}: not found` `` |

## Test policy rows

Skipped (profile light). Checklist has no `## Test policy` section.

## Faults injected

Skipped (profile light). No faults injected.

## Coverage join

Skipped (profile light; brief: do not recompute).

## Gate

`npx vitest run apps/cli/test/agents.test.ts packages/agent-runtime/test/agent-runtime.test.ts -t "does not forward SECRET_TOKEN to health-check children|reports fixture agents available and authenticated without printing secrets|buildChildEnvironment forwards base keys and allowlist without secrets" --reporter=verbose` — 3 passed, 0 failed, 34 skipped.
