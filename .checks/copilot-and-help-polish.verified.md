# Copilot nits and HTML help polish Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: main (`cd4e44be93d7ba7391d9b84e5b4d1147040e2ead`)..HEAD (`e838611b05fd81201ccdb34de4e6dd54d723d1cd`)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

## Binding sources

Step 1 skipped (profile light; brief: skip ui). No source is marked **binding**. Sources the checklist named were opened so the Checks table is not citing unread artifacts.

| Source                               | Opened                                  | Contradiction                                             | Uncovered |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------- | --------- |
| `.tasks/copilot-and-help-polish.md`  | yes                                     | n/a — step 1 skipped (light)                              | n/a       |
| Copilot review on PR #17             | no — not marked binding; step 1 skipped | n/a                                                       | n/a       |
| PR #27 notes                         | no — not marked binding; step 1 skipped | n/a                                                       | n/a       |
| `.checks/copilot-and-help-polish.md` | yes                                     | n/a — the checklist is the contract, not a binding design | n/a       |

## Checks

Named tests exist (`rg`):

- `apps/cli/test/agents.test.ts:77` `it('names documented grok authentication recovery'`
- `packages/agent-runtime/test/profiles.test.ts:88` `it('derives AGENT_PROFILE_IDS from the profile table'`
- `apps/cli/test/help.test.ts:94` `it('prints the help root when --path is combined with --html'`
- `apps/cli/test/help.test.ts:107` `it('rejects html topics that are not manifest page ids'`
- `apps/cli/test/help-manifest.test.ts:39` `it('keeps Instagram reel examples free of required --stt'`

One vitest invocation at HEAD, verbose reporter: those five ran and passed; 16 others skipped. File proofs C2–C4 (and C8 examples) were read at HEAD; all five test files appear in `main...HEAD`.

| Check | Claim                                                                                                                                                   | Proof run                                                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Result |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1    | Grok unauthenticated doctor recovery names `grok login` and `XAI_API_KEY` and omits parent secret values; Codex/Claude stay `sign in with <executable>` | verbose vitest (see Gate) — `agent doctor > names documented grok authentication recovery` pass 4ms                                                     | Precondition `apps/cli/test/agents.test.ts:78-82` — `runCli(['agent', 'doctor', 'grok'], { environment: { XAI_API_KEY: 'xai-must-not-print' }, agentHealthProbe: { check: async () => ({ available: true, version: 'grok 0.1.0', authenticated: false }) } })`. Assertions `agents.test.ts:87-97` — `expect(grok.stdout).toContain('grok login')`; `toContain('XAI_API_KEY')`; `not.toContain('xai-must-not-print')`; Codex `runCli(['agent', 'doctor', 'codex'], … authenticated: false)` then `expect(codex.stdout).toContain('sign in with codex and retry.')` | PASS   |
| C2    | `serveMcp` docblock names Grok                                                                                                                          | file `apps/cli/src/commands/mcp.ts` at HEAD                                                                                                             | `apps/cli/src/commands/mcp.ts:190` — `/** Starts the local-only stdio server used by Codex, Claude, and Grok configurations. */` immediately above `export async function serveMcp`                                                                                                                                                                                                                                                                                                                                                                               | PASS   |
| C3    | `App.tsx` has no `@sheldon/agent-runtime` import and the query select still lists `codex`, `claude`, `grok`                                             | file `apps/web/src/App.tsx` at HEAD                                                                                                                     | `rg` `@sheldon/agent-runtime` in `apps/web/src/App.tsx` — no matches. Imports `App.tsx:1-3` are `react`, `./client.generated.js`, `./styles.css`. Local union `App.tsx:5` — `type AgentKind = 'codex' \| 'claude' \| 'grok'`. Select `App.tsx:417-421` — `<option value="codex">`, `<option value="claude">`, `<option value="grok">`                                                                                                                                                                                                                             | PASS   |
| C4    | ADR-004 names Codex, Claude, and Grok and still forbids model APIs                                                                                      | file `docs/product/decisions.md` at HEAD                                                                                                                | `docs/product/decisions.md:23-24` — `Codex CLI, Claude Code e Grok CLI são os workers. O Sheldon não chama APIs de modelos.` Update `decisions.md:28-30` points at ADR-015 and restates the model-API restriction                                                                                                                                                                                                                                                                                                                                                 | PASS   |
| C5    | `AGENT_PROFILE_IDS` equals `listAgentProfiles().map((p) => p.id)` because it is derived from the table                                                  | verbose vitest — `agent profiles > derives AGENT_PROFILE_IDS from the profile table` pass 1ms                                                           | `packages/agent-runtime/test/profiles.test.ts:89-90` — `expect(AGENT_PROFILE_IDS).toEqual(listAgentProfiles().map((profile) => profile.id))`; `expect(AGENT_PROFILE_IDS).toEqual(['codex', 'claude', 'grok'])`. Implementation in the same diff `packages/agent-runtime/src/profiles.ts:95` — `export const AGENT_PROFILE_IDS = profiles.map((profile) => profile.id)`                                                                                                                                                                                            | PASS   |
| C6    | `sheldon help --path --html` prints the help root and does not open a browser                                                                           | verbose vitest — `html help > prints the help root when --path is combined with --html` pass 8ms                                                        | `apps/cli/test/help.test.ts:98-104` — `runCli(['help', '--path', '--html'], …)`; `expect(result.exitCode).toBe(0)`; `expect(result.stdout).toContain(helpRoot)`; `expect(open).not.toHaveBeenCalled()`                                                                                                                                                                                                                                                                                                                                                            | PASS   |
| C7    | `--html` topics outside the manifest, including `../secret`, yield `HELP_PAGE_MISSING` and do not open; `init` still opens                              | verbose vitest — `html help > rejects html topics that are not manifest page ids` pass 8ms                                                              | `apps/cli/test/help.test.ts:118-133` — `missing-topic` and `extra` `exitCode` 1 + `stderr` `HELP_PAGE_MISSING`; `runCli(['help', '--html', '../secret'], …)` same; `expect(open).not.toHaveBeenCalled()` then `runCli(['help', '--html', 'init'], …)` `exitCode` 0 and `open` called with `pages/init.html`                                                                                                                                                                                                                                                       | PASS   |
| C8    | Instagram Reel examples omit `--stt`; flags list still documents `--stt`                                                                                | verbose vitest — `help manifest coverage > keeps Instagram reel examples free of required --stt` pass 3ms; file `apps/cli/help/pages/ingest.md` at HEAD | Test `apps/cli/test/help-manifest.test.ts:44-49` — Instagram `sheldon ingest url` lines `not.toContain('--stt')`; `expect(page).toContain('`--stt`')`. Page `ingest.md:25` flags list — `` `--stt` — (`ingest url` only) allow an already-installed local speech-to-text runtime ``. Examples `ingest.md:93` and `ingest.md:99` — both Instagram commands have `--media thumbnail --vault` and no `--stt`                                                                                                                                                         | PASS   |

### Level / sampling (light)

- C1 names CLI `sheldon agent doctor grok` plus Codex/Claude stay-copy. The proof is `runCli(['agent', 'doctor', 'grok'], …)` and a second `runCli` for `codex`. Claude is not called. Codex and Claude share the remaining template `sign in with ${profile.executable}` (`apps/cli/src/commands/agents.ts:64`); that is a shared-branch sample, not two distinct recovery surfaces proven on one. Secret omission is asserted on the Grok stdout (`xai-must-not-print`). No level gap.
- C2–C4 are file reads at the named surfaces (JSDoc, web select, ADR-004). No sampling gap: C3 lists all three option values; C4 names all three workers and the model-API forbid on adjacent lines.
- C5 names the derived tuple. The proof `toEqual`s the full mapped id list and the three ids. Not a sample.
- C6 names the combined `--path --html` CLI; the proof is that argv. Opener not called is asserted at the injected `open` spy, which is the test seam for “does not open a browser”.
- C7 names unknown tokens and `../secret` plus `init` still opens. The proof runs `missing-topic`, `../secret`, and `init`, and also `extra` (file on disk, not a manifest id). No under-sample.
- C8 names Instagram Reel examples (plural) and the flags list. The test collects every `sheldon ingest url…instagram` command; the page has two (PowerShell and Unix). Flags `--stt` is a literal on the page. No sampling gap.

## Swept (`existing` re-read)

n/a rows are policy. `validation: C7`, `failure modes: C7`, and `observability: C1` are check mappings, not `existing` constraints.

| Row                         | Cited constraint                 | In code?                                                                                                                                                                                                                                                                                              |
| --------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| external-dependency failure | `HELP_PAGE_MISSING` already used | yes — `apps/cli/src/help.ts:23` throws `HELP_PAGE_MISSING` when the topic fails `helpTopicId` or is absent from `pageIds`; `help.ts:40` missing manifest; `help.ts:49` missing file. CLI maps it `apps/cli/src/main.ts:165-169` — `message.startsWith('HELP_PAGE_MISSING:')` → stderr + `exitCode: 1` |

## Test policy rows

Skipped (profile light). Checklist has no `## Test policy` section.

## Faults injected

Skipped (profile light). No faults injected.

## Coverage join

Skipped (profile light; brief: do not recompute).

## Gate

`npx vitest run apps/cli/test/agents.test.ts packages/agent-runtime/test/profiles.test.ts apps/cli/test/help.test.ts apps/cli/test/help-manifest.test.ts -t "names documented grok authentication recovery|derives AGENT_PROFILE_IDS from the profile table|prints the help root when --path is combined with --html|rejects html topics that are not manifest page ids|keeps Instagram reel examples free of required --stt" --reporter=verbose` — 5 passed, 0 failed, 16 skipped.
