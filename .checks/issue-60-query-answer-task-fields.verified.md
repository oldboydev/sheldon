<!-- markdownlint-disable MD034 MD060 -->

# Query answer task fields and partial section salvage Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `fd483c31a3fcd6deb32e740fe004c9bb16c327dd`..`3922ec323e1f7b908b8afbc9ab74c44d14aac411` (`origin/main`..`HEAD`)
**Round**: 2 - scoped
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs` (node v24.22.1). Proofs re-run in **one** vitest invocation at HEAD `3922ec3`. Each named `it('…')` exists (`rg`) and appeared individually as passed (9 passed, 0 failed, 60 skipped by filter).

Fix under review: `3922ec3` `test(query): lock persisted truncated to the index, not the agent echo` — only `apps/cli/test/query-acceptance.test.ts` assertions for truncated. Round 1 FAIL was C2 only. C1 and C3 share that `it()`, so those citations are refreshed. C4–C9 carried from `e1091b1` after the full re-run still passed them.

Skipped under **light** (not forgotten): Binding sources step (ui) screen/arrangement enumeration, Coverage join, Test policy rows, fault injection.

No production code, tests, checklist, or task were edited.

## Binding sources

carried from `e1091b1`. Checklist unchanged (not renegotiated). Step 1 still skipped — profile light.

| Source | Opened | Contradiction | Uncovered |
| --- | --- | --- | --- |
| step 1 (screens / ui) | skipped — profile light; no source marked binding | n/a | n/a |
| https://github.com/oldboydev/sheldon/issues/60 | not opened as binding — checklist Sources only | n/a | n/a |
| https://github.com/oldboydev/sheldon/issues/62 | not opened as binding — checklist Sources only | n/a | n/a |
| `.tasks/issue-60-query-answer-task-fields.md` | yes — criteria 1–9 | none vs C1–C9 / Landing (not binding) | n/a |
| `.checks/issue-60-query-answer-task-fields.md` | yes | n/a — the checklist is the contract, not a binding design | n/a |

## Checks

Named tests exist (`rg`) at HEAD `3922ec3`:

- `apps/cli/test/query-acceptance.test.ts:330` `it('saves a cited answer when the agent echoes a different id and truncation state'`
- `packages/agent-runtime/test/agent-runtime.test.ts:415` `it('canonicalizes a query answer that has only a Wiki facts section'`
- `apps/cli/test/query-acceptance.test.ts:418` `it('saves a cited answer that only includes a Wiki facts section'`
- `packages/agent-runtime/test/agent-runtime.test.ts:454` `it('rewrites close heading variants into the required ATX section names'`
- `packages/agent-runtime/test/agent-runtime.test.ts:433` `it('inserts a canonical Inferences section between Wiki facts and Gaps'`
- `apps/cli/test/query-acceptance.test.ts:478` `it('rejects an agent answer that cites wiki evidence outside the selected context'`
- `apps/cli/test/query-acceptance.test.ts:539` `it('rejects an agent answer that omits citations for the selected wiki context'`
- `apps/cli/test/query-acceptance.test.ts:600` `it('does not save an answer when the agent returns unreadable query output'`
- `apps/web/test/app-shell.test.tsx:237` `it('consulta translates evidence-outside-context failure into Portuguese'`

C5’s `it` body is pre-existing (0.2.10); it still calls `validateQueryAnswer` on the changed `canonicalizeHeadings` → `ensureAnswerSections` pipeline, so it is a regression proof of this diff, not an untouched suite.

| Check | Claim | Proof run | Evidence | Result |
| --- | --- | --- | --- | --- |
| C1 | JSON parseável com `text`/`concepts` válidos e `id` diferente do pedido grava `outputs/answers/<answer-id>/answer.json` com o `id` da tarefa | verbose vitest at `3922ec3` — `saves a cited answer when the agent echoes a different id and truncation state` pass 61ms | `apps/cli/test/query-acceptance.test.ts:392-396` path `…/answers/resposta-task/answer.json`; `:403-407` `expect(saved).toMatchObject({ id: 'resposta-task', question: 'retrieval practice', agent: 'grok' })`; `:413` `expect(saved.id).not.toBe('answer-1')` | PASS (citations refreshed; same `it()` as C2) |
| C2 | O mesmo JSON com `truncated` diferente do `QueryResult` persiste o `truncated` do índice | same proof as C1 — test ran and passed 61ms | Capture in the same `it()`: `:343` `indexTruncated = command.input.truncated`; `:344` `echoedTruncated = !command.input.truncated`; agent payload `:353` `truncated: echoedTruncated`. Assertions: `:410` `expect(echoedTruncated).not.toBe(indexTruncated)`; `:411` `expect(saved.truncated).toBe(indexTruncated)`; `:412` `expect(saved.truncated).not.toBe(echoedTruncated)`. Expected is the captured index boolean, not `JSON.parse(queried.stdout).truncated`. Round 1 tautology is gone. | PASS |
| C3 | `question` e `agent` persistidos são os da tarefa, não o eco | same proof as C1 — test ran and passed 61ms | `:403-406` `toMatchObject({ question: 'retrieval practice', agent: 'grok' })`; `:414` `expect(saved.question).not.toBe('a rewritten question')`; `:415` `expect(saved.agent).not.toBe('codex')` | PASS (citations refreshed; same `it()` as C2) |
| C4 | Texto com só `## Wiki facts` e citação `wiki/…` grava as três secções canónicas na ordem Wiki facts → Inferences → Gaps | verbose vitest at `3922ec3` — both named proofs passed (2ms / 45ms) | carried from `e1091b1`. Runtime `:421-429` `toMatch(/^## Wiki facts\r?$/m)` / `## Inferences` / `## Gaps`; `indexOf('## Wiki facts')` `<` `## Inferences` `<` `## Gaps`. CLI `:471-475` same three headings and order on saved `answer.json`. | PASS (carried from `e1091b1`) |
| C5 | Heading ATX/bold já coberto pela 0.2.10 continua a gravar com os três `##` canónicos | verbose vitest at `3922ec3` — `rewrites close heading variants into the required ATX section names` pass 0ms | carried from `e1091b1`. Input `# Wiki facts:` / `**Inferences**` / `### Gaps`. `:469` `expect(result.answer.text).toMatch(/^## Wiki facts\r?$/m)`; `:470` `## Inferences`; `:471` `## Gaps`. | PASS (carried from `e1091b1`) |
| C6 | `## Wiki facts` e `## Gaps` sem `## Inferences` persiste `## Inferences` seguido de `- None.` entre as duas | verbose vitest at `3922ec3` — `inserts a canonical Inferences section between Wiki facts and Gaps` pass 0ms | carried from `e1091b1`. `:448-450` `expect(inferencesIndex).toBeGreaterThan(factsIndex)` / `toBeLessThan(gapsIndex)`; `:450` `expect(result.answer.text.slice(inferencesIndex, gapsIndex)).toContain('- None.')` | PASS (carried from `e1091b1`) |
| C7 | Citação fora do contexto ou omissão de citações do wiki selecionado falha o job sem `answer.json` | verbose vitest at `3922ec3` — both named proofs passed (39ms / 34ms) | carried from `e1091b1`. Outside `:521` `expect(result.exitCode).toBe(1)`; `:522` `toContain('outside its context')`; `:523-536` `readFile(…/answer-outside-context/answer.json)` `rejects.toMatchObject({ code: 'ENOENT' })`. Omits `:582` `exitCode` `1`; `:583` `toContain('omits citations')`; `:584-597` `ENOENT` on `answer-omits-citations/answer.json`. | PASS (carried from `e1091b1`) |
| C8 | JSON ilegível falha o job sem ficheiro | verbose vitest at `3922ec3` — `does not save an answer when the agent returns unreadable query output` pass 39ms | carried from `e1091b1`. `:632` `expect(result.exitCode).toBe(1)`; `:633` `toContain('did not produce a valid cited query answer')`; `:634-647` `readFile(…/answer-unreadable/answer.json)` `rejects.toMatchObject({ code: 'ENOENT' })` | PASS (carried from `e1091b1`) |
| C9 | Na Consulta, falha de evidência aparece em `.notice.error` em português, sem `outside its context` nem `omits citations` | verbose vitest at `3922ec3` — `consulta translates evidence-outside-context failure into Portuguese` pass 66ms | carried from `e1091b1`. `:257` `container!.querySelector('.notice.error')`; `:258-260` `toContain('Sheldon não gravou a resposta')` / `'Tente de novo'` / `not.toContain('outside its context')`; `:269-271` omitted path `toContain('Sheldon não gravou a resposta')` / `not.toContain('omits citations')` | PASS (carried from `e1091b1`) |

C2 no longer compares the saved file to `answers.save` stdout. `saved.truncated` is locked to captured `command.input.truncated` (`indexTruncated`) and asserted not equal to the echoed `!command.input.truncated` (`echoedTruncated`).

## Swept (`existing` re-read against code at HEAD)

carried from `e1091b1`. Fix `3922ec3` did not touch production code.

n/a rows are policy. Check-mapped rows (validation C1–C6, failure modes C7–C9, data lifecycle C1, dependency failure C8, observability C9) are proven in the Checks table, not re-litigated here.

| Row | Cited constraint | In code? |
| --- | --- | --- |
| idempotency | existing — `QueryAnswerStore.save` pela mesma chave | yes — `packages/agent-runtime/src/query-answer-store.ts:24-29` `save` writes `join(this.directory(answer.id), 'answer.json')`; `:82-83` `directory(id)` → `outputs/answers/${id}`. Same `answer.id` overwrites the same file. Unchanged in this diff. |
| state transitions | existing — job `failed` / `succeeded` | yes — `apps/web/src/jobs.ts:208-211` executor success → `status = 'succeeded'`; catch → `'failed'` (abort → `'cancelled'`). `App.tsx:441-445` branches `job?.status === 'failed'` vs `!== 'succeeded'`; `:459` error notice only when `failed`. This delivery only changes `queryJobErrorNotice` copy, not the statuses. |

## Coverage

no Coverage recompute — profile light

## Test policy rows

no Test policy section required — profile light

## Faults injected

no faults injected — profile light

## Gate

```text
npx vitest run apps/cli/test/query-acceptance.test.ts packages/agent-runtime/test/agent-runtime.test.ts apps/web/test/app-shell.test.tsx -t "saves a cited answer when the agent echoes a different id and truncation state|canonicalizes a query answer that has only a Wiki facts section|saves a cited answer that only includes a Wiki facts section|rewrites close heading variants into the required ATX section names|inserts a canonical Inferences section between Wiki facts and Gaps|rejects an agent answer that cites wiki evidence outside the selected context|rejects an agent answer that omits citations for the selected wiki context|does not save an answer when the agent returns unreadable query output|consulta translates evidence-outside-context failure into Portuguese" --reporter=verbose
```

9 passed, 0 failed, 60 skipped (filter). Each named proof appeared individually as `✓` at HEAD `3922ec323e1f7b908b8afbc9ab74c44d14aac411`.

Verification PASS: 9/9 checks proven.

Residual (does not fail a check; carried from `e1091b1`): C8 stubs `executeQuery` as `{ status: 'error', message: '…did not produce a valid cited query answer.' }` rather than feeding unparseable stdout through the adapter; the CLI observable (exit 1, no `answer.json`) is still asserted.
