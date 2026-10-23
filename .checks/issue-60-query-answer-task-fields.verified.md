<!-- markdownlint-disable MD034 MD060 -->

# Query answer task fields and partial section salvage Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `fd483c31a3fcd6deb32e740fe004c9bb16c327dd`..`40c270534344753becc95c09c6abc88b93fa3358` (`origin/main`..`HEAD`)
**Round**: 3 - scoped
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs` (node v24.22.1). Proofs re-run in **one** vitest invocation at HEAD `40c2705`. Each named `it('…')` exists (`rg`) and appeared individually as passed (9 passed, 0 failed, 60 skipped by filter).

Fix under review: `40c2705` `fix(web): translate remaining query-answer evidence failures` — `App.tsx` `queryJobErrorNotice` now matches `must include concept citations` / `must include raw citations` / remaining `Proposal is invalid`; C9 `it()` adds that case; C1–C3 `it()` adds `saved.text` `## Wiki facts` + `wiki/recall.md`. Round 2 PASS was at `3922ec3` (C2 index-vs-echo only; CONTRIBUTING gates not in evidence). `8e89951` recorded that Round 2 report.

Skipped under **light** (not forgotten): Binding sources step (ui) screen/arrangement enumeration, Coverage join, Test policy rows, fault injection.

No production code, tests, checklist, or task were edited.

## Binding sources

carried from `e1091b1` / Round 2 at `3922ec3`. Checklist unchanged (not renegotiated). Step 1 still skipped — profile light. `40c2705` did not touch a binding design.

| Source                                         | Opened                                            | Contradiction                                             | Uncovered |
| ---------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | --------- |
| step 1 (screens / ui)                          | skipped — profile light; no source marked binding | n/a                                                       | n/a       |
| https://github.com/oldboydev/sheldon/issues/60 | not opened as binding — checklist Sources only    | n/a                                                       | n/a       |
| https://github.com/oldboydev/sheldon/issues/62 | not opened as binding — checklist Sources only    | n/a                                                       | n/a       |
| `.tasks/issue-60-query-answer-task-fields.md`  | yes — criteria 1–9                                | none vs C1–C9 / Landing (not binding)                     | n/a       |
| `.checks/issue-60-query-answer-task-fields.md` | yes                                               | n/a — the checklist is the contract, not a binding design | n/a       |

## Checks

Named tests exist (`rg`) at HEAD `40c2705`:

- `apps/cli/test/query-acceptance.test.ts:330` `it('saves a cited answer when the agent echoes a different id and truncation state'`
- `packages/agent-runtime/test/agent-runtime.test.ts:415` `it('canonicalizes a query answer that has only a Wiki facts section'`
- `apps/cli/test/query-acceptance.test.ts:421` `it('saves a cited answer that only includes a Wiki facts section'`
- `packages/agent-runtime/test/agent-runtime.test.ts:454` `it('rewrites close heading variants into the required ATX section names'`
- `packages/agent-runtime/test/agent-runtime.test.ts:433` `it('inserts a canonical Inferences section between Wiki facts and Gaps'`
- `apps/cli/test/query-acceptance.test.ts:481` `it('rejects an agent answer that cites wiki evidence outside the selected context'`
- `apps/cli/test/query-acceptance.test.ts:542` `it('rejects an agent answer that omits citations for the selected wiki context'`
- `apps/cli/test/query-acceptance.test.ts:603` `it('does not save an answer when the agent returns unreadable query output'`
- `apps/web/test/app-shell.test.tsx:237` `it('consulta translates evidence-outside-context failure into Portuguese'`

C5’s `it` body is pre-existing (0.2.10); it still calls `validateQueryAnswer` on the changed `canonicalizeHeadings` → `ensureAnswerSections` pipeline, so it is a regression proof of this diff, not an untouched suite.

| Check | Claim                                                                                                                                        | Proof run                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Result                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C1    | JSON parseável com `text`/`concepts` válidos e `id` diferente do pedido grava `outputs/answers/<answer-id>/answer.json` com o `id` da tarefa | verbose vitest at `40c2705` — `saves a cited answer when the agent echoes a different id and truncation state` pass 82ms | `apps/cli/test/query-acceptance.test.ts:392-396` path `…/answers/resposta-task/answer.json`; `:404-408` `expect(saved).toMatchObject({ id: 'resposta-task', question: 'retrieval practice', agent: 'grok' })`; `:414` `expect(saved.id).not.toBe('answer-1')`. New at HEAD (`40c2705`): `:417` `expect(saved.text).toMatch(/^## Wiki facts\r?$/m)`; `:418` `expect(saved.text).toContain('wiki/recall.md')`.                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS (citations refreshed at `40c2705`; same `it()` as C2/C3)   |
| C2    | O mesmo JSON com `truncated` diferente do `QueryResult` persiste o `truncated` do índice                                                     | same proof as C1 — test ran and passed 82ms                                                                              | Capture in the same `it()`: `:339-340` `indexTruncated` / `echoedTruncated`; `:343` `indexTruncated = command.input.truncated`; `:344` `echoedTruncated = !command.input.truncated`; agent payload `:353` `truncated: echoedTruncated`. Assertions: `:411` `expect(echoedTruncated).not.toBe(indexTruncated)`; `:412` `expect(saved.truncated).toBe(indexTruncated)`; `:413` `expect(saved.truncated).not.toBe(echoedTruncated)`. Expected is the captured index boolean, not `JSON.parse(queried.stdout).truncated`. New at HEAD: `:417` `saved.text` `toMatch(/^## Wiki facts\r?$/m)`; `:418` `toContain('wiki/recall.md')`.                                                                                                                                                                                                         | PASS                                                            |
| C3    | `question` e `agent` persistidos são os da tarefa, não o eco                                                                                 | same proof as C1 — test ran and passed 82ms                                                                              | `:404-408` `toMatchObject({ question: 'retrieval practice', agent: 'grok' })`; `:415` `expect(saved.question).not.toBe('a rewritten question')`; `:416` `expect(saved.agent).not.toBe('codex')`. New at HEAD: `:417-418` `saved.text` `^## Wiki facts` and `wiki/recall.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS (citations refreshed at `40c2705`; same `it()` as C1/C2)   |
| C4    | Texto com só `## Wiki facts` e citação `wiki/…` grava as três secções canónicas na ordem Wiki facts → Inferences → Gaps                      | verbose vitest at `40c2705` — both named proofs passed (2ms / 40ms)                                                      | Runtime `:421-429` `toMatch(/^## Wiki facts\r?$/m)` / `## Inferences` / `## Gaps`; `indexOf('## Wiki facts')` `<` `## Inferences` `<` `## Gaps`; `:430` `toContain('wiki/concepts/example.md')`. CLI `:474-478` same three headings and order on saved `answer.json`. Line numbers shifted vs Round 2 because C1–C3 `it()` grew; bodies unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PASS (proof re-run at `40c2705`; bodies carried from `e1091b1`) |
| C5    | Heading ATX/bold já coberto pela 0.2.10 continua a gravar com os três `##` canónicos                                                         | verbose vitest at `40c2705` — `rewrites close heading variants into the required ATX section names` pass 0ms             | Input `# Wiki facts:` / `**Inferences**` / `### Gaps`. `:469` `expect(result.answer.text).toMatch(/^## Wiki facts\r?$/m)`; `:470` `## Inferences`; `:471` `## Gaps`. Unchanged in `40c2705`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PASS (proof re-run at `40c2705`; body carried from `e1091b1`)   |
| C6    | `## Wiki facts` e `## Gaps` sem `## Inferences` persiste `## Inferences` seguido de `- None.` entre as duas                                  | verbose vitest at `40c2705` — `inserts a canonical Inferences section between Wiki facts and Gaps` pass 0ms              | `:448-450` `expect(inferencesIndex).toBeGreaterThan(factsIndex)` / `toBeLessThan(gapsIndex)`; `:450` `expect(result.answer.text.slice(inferencesIndex, gapsIndex)).toContain('- None.')`. Unchanged in `40c2705`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PASS (proof re-run at `40c2705`; body carried from `e1091b1`)   |
| C7    | Citação fora do contexto ou omissão de citações do wiki selecionado falha o job sem `answer.json`                                            | verbose vitest at `40c2705` — both named proofs passed (40ms / 38ms)                                                     | Outside `:524` `expect(result.exitCode).toBe(1)`; `:525` `toContain('outside its context')`; `:526-539` `readFile(…/answer-outside-context/answer.json)` `rejects.toMatchObject({ code: 'ENOENT' })`. Omits `:585` `exitCode` `1`; `:586` `toContain('omits citations')`; `:587-600` `ENOENT` on `answer-omits-citations/answer.json`. Line numbers shifted vs Round 2; bodies unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                              | PASS (proof re-run at `40c2705`; bodies carried from `e1091b1`) |
| C8    | JSON ilegível falha o job sem ficheiro                                                                                                       | verbose vitest at `40c2705` — `does not save an answer when the agent returns unreadable query output` pass 40ms         | `:635` `expect(result.exitCode).toBe(1)`; `:636` `toContain('did not produce a valid cited query answer')`; `:637-650` `readFile(…/answer-unreadable/answer.json)` `rejects.toMatchObject({ code: 'ENOENT' })`. Unchanged in `40c2705`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PASS (proof re-run at `40c2705`; body carried from `e1091b1`)   |
| C9    | Na Consulta, falha de evidência aparece em `.notice.error` em português, sem `outside its context` nem `omits citations`                     | verbose vitest at `40c2705` — `consulta translates evidence-outside-context failure into Portuguese` pass 53ms           | Outside: `:257` `container!.querySelector('.notice.error')`; `:258-260` `toContain('Sheldon não gravou a resposta')` / `'Tente de novo'` / `not.toContain('outside its context')`. Omits: `:270-271` `toContain('Sheldon não gravou a resposta')` / `not.toContain('omits citations')`. New at HEAD (`40c2705`): `:277` error `'Proposal is invalid: A query answer must include concept citations.'`; `:280` `missingConcepts = …querySelector('.notice.error')`; `:281` `toContain('Sheldon não gravou a resposta')`; `:282` `toContain('Tente de novo')`; `:283` `not.toContain('Proposal is invalid')`; `:284` `not.toContain('must include concept citations')`. Production: `apps/web/src/App.tsx:410-416` matches those English phrases and returns the Portuguese citation notice; `:421-422` remaining `Proposal is invalid`. | PASS                                                            |

C2 still locks `saved.truncated` to captured `command.input.truncated` (`indexTruncated`) and asserts it is not the echoed `!command.input.truncated` (`echoedTruncated`). C9 still forbids the English evidence phrases and now also forbids `Proposal is invalid` / `must include concept citations` on the same `.notice.error`.

## Swept (`existing` re-read against code at HEAD)

idempotency / state-transition rows carried from `e1091b1` (unchanged in `40c2705`). Observability refreshed: `40c2705` extended `queryJobErrorNotice`.

n/a rows are policy. Check-mapped rows (validation C1–C6, failure modes C7–C9, data lifecycle C1, dependency failure C8, observability C9) are proven in the Checks table, not re-litigated here.

| Row               | Cited constraint                                    | In code?                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| idempotency       | existing — `QueryAnswerStore.save` pela mesma chave | yes — `packages/agent-runtime/src/query-answer-store.ts:24-29` `save` writes `join(this.directory(answer.id), 'answer.json')`; `:82-83` `directory(id)` → `outputs/answers/${id}`. Same `answer.id` overwrites the same file. Unchanged in this diff.                                                                        |
| state transitions | existing — job `failed` / `succeeded`               | yes — `apps/web/src/jobs.ts:208-211` executor success → `status = 'succeeded'`; catch → `'failed'` (abort → `'cancelled'`). `App.tsx:446-450` branches `job?.status === 'failed'` vs `!== 'succeeded'`; `:463-465` error notice only when `failed`. This delivery only changes `queryJobErrorNotice` copy, not the statuses. |
| observability     | C9 — notice da Consulta                             | yes — `App.tsx:399-425` `queryJobErrorNotice`; `:410-416` `outside its context` / `omits citations` / `must include concept citations` → Portuguese citation copy; `:421-422` remaining `Proposal is invalid` → Portuguese generic save-failure copy. `40c2705` added the last two matchers.                                 |

## Coverage

no Coverage recompute — profile light

## Test policy rows

no Test policy section required — profile light

## Faults injected

no faults injected — profile light

## Gate

Proofs (one vitest invocation at HEAD `40c270534344753becc95c09c6abc88b93fa3358`):

```text
npx vitest run apps/cli/test/query-acceptance.test.ts packages/agent-runtime/test/agent-runtime.test.ts apps/web/test/app-shell.test.tsx -t "saves a cited answer when the agent echoes a different id and truncation state|canonicalizes a query answer that has only a Wiki facts section|saves a cited answer that only includes a Wiki facts section|rewrites close heading variants into the required ATX section names|inserts a canonical Inferences section between Wiki facts and Gaps|rejects an agent answer that cites wiki evidence outside the selected context|rejects an agent answer that omits citations for the selected wiki context|does not save an answer when the agent returns unreadable query output|consulta translates evidence-outside-context failure into Portuguese" --reporter=verbose
```

9 passed, 0 failed, 60 skipped (filter). Each named proof appeared individually as `✓`. Exit 0.

CONTRIBUTING applicable gates, run by this verifier at HEAD `40c2705` (working tree clean):

```text
npx prettier --check apps/cli/src/commands/query.ts packages/agent-runtime/src/query-answer.ts apps/web/src/App.tsx apps/cli/test/query-acceptance.test.ts packages/agent-runtime/test/agent-runtime.test.ts apps/web/test/app-shell.test.tsx CHANGELOG.md README.md apps/cli/help/pages/query.md .tasks/issue-60-query-answer-task-fields.md .checks/issue-60-query-answer-task-fields.md
```

Exit 0. "All matched files use Prettier code style!"

```text
npx eslint apps/cli/src/commands/query.ts packages/agent-runtime/src/query-answer.ts apps/web/src/App.tsx apps/cli/test/query-acceptance.test.ts packages/agent-runtime/test/agent-runtime.test.ts apps/web/test/app-shell.test.tsx
```

Exit 0.

```text
npx tsc --noEmit
```

Exit 0.

```text
npx markdownlint-cli2 ".tasks/issue-60-query-answer-task-fields.md" ".checks/issue-60-query-answer-task-fields.md" "CHANGELOG.md" "README.md" "apps/cli/help/pages/query.md"
```

Exit 0. "Summary: 0 issues in 0 files".

```text
npm run lint:repo
```

Exit 0. Porcelain empty (`git status --porcelain` blank), so `scripts/verify-change-policy.mjs` ran `evaluateChangePolicy([])` — a no-op on uncommitted paths. Last implementation commit `40c2705` includes `README.md` and `CHANGELOG.md` (Consulta copy for `concepts` ausente / `Proposal is invalid`).

```text
git diff --check
```

Exit 0.

Verification PASS: 9/9 checks proven.

Residual (does not fail a check; carried from `e1091b1`): C8 stubs `executeQuery` as `{ status: 'error', message: '…did not produce a valid cited query answer.' }` rather than feeding unparseable stdout through the adapter; the CLI observable (exit 1, no `answer.json`) is still asserted.
