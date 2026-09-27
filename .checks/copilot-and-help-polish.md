# Copilot nits and HTML help polish

Sources:

- `.tasks/copilot-and-help-polish.md` - criteria 1–8
- Copilot review on PR #17 - five suppressed copy/type findings
- PR #27 notes - deferred HTML help polish

Profile: `light`. Handoff: one slice, no split.

## Out of scope

- Real `agentVersion` detection
- npm release
- Importing `@sheldon/agent-runtime` into the web client

## Landing

CLI doctor recovery, `help.ts` topic ids from the packaged `manifest.json`, ingest Markdown
examples, ADR-004, `serveMcp` JSDoc, local `AgentKind` in `App.tsx`, `AGENT_PROFILE_IDS`
derived from the profile table.

| One-way door                                                     | Literal shape | Alternative rejected |
| ---------------------------------------------------------------- | ------------- | -------------------- |
| None - docs, copy, a local union, and deriving an existing tuple |               |                      |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Copilot nits and HTML help polish · ~8 files · ~7k

**C1** - Grok unauthenticated doctor recovery names `grok login` and `XAI_API_KEY` and omits
parent secret values; Codex/Claude stay `sign in with <executable>`
Proof: `npx vitest run apps/cli/test/agents.test.ts -t "names documented grok authentication recovery"`

**C2** - `serveMcp` docblock names Grok
Proof: file `apps/cli/src/commands/mcp.ts` (docs; verifier reads the docblock)

**C3** - `App.tsx` has no `@sheldon/agent-runtime` import and the query select still lists
`codex`, `claude`, `grok`
Proof: file `apps/web/src/App.tsx` (docs/UI copy; verifier reads the select)

**C4** - ADR-004 names Codex, Claude, and Grok and still forbids model APIs
Proof: file `docs/product/decisions.md` (docs; verifier reads ADR-004)

**C5** - `AGENT_PROFILE_IDS` equals `listAgentProfiles().map((p) => p.id)` because it is
derived from the table
Proof: `npx vitest run packages/agent-runtime/test/profiles.test.ts -t "derives AGENT_PROFILE_IDS from the profile table"`

**C6** - `sheldon help --path --html` prints the help root and does not open a browser
Proof: `npx vitest run apps/cli/test/help.test.ts -t "prints the help root when --path is combined with --html"`

**C7** - `--html` topics outside the manifest, including `../secret`, yield `HELP_PAGE_MISSING`
and do not open; `init` still opens
Proof: `npx vitest run apps/cli/test/help.test.ts -t "rejects html topics that are not manifest page ids"`

**C8** - Instagram Reel examples omit `--stt`; flags list still documents `--stt`
Proof: file `apps/cli/help/pages/ingest.md` (docs; verifier reads the examples)

## Swept

- validation: C7
- failure modes: C7
- idempotency and retry: n/a
- authorization: n/a
- concurrency and ordering: n/a
- data lifecycle: n/a
- external-dependency failure: existing HELP_PAGE_MISSING
- state transitions: n/a
- observability: C1

## Handoff

S1 only, under 150k. No split.

## Coverage

| Set (size)                      | Member -> proof                                                   | Unproven |
| ------------------------------- | ----------------------------------------------------------------- | -------- |
| Copilot PR #17 nits (5)         | recovery C1 · JSDoc C2 · App.tsx C3 · ADR-004 C4 · profile ids C5 | -        |
| PR #27 help polish (3)          | `--path`+`--html` C6 · manifest ids C7 · Instagram `--stt` C8     | -        |
| agent kinds in query select (3) | `codex` C3 · `claude` C3 · `grok` C3                              | -        |
