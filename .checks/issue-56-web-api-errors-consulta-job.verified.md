<!-- markdownlint-disable MD034 MD060 -->

# Web API errors, Consulta job tracking, Fontes file drop Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `d68e2bef537dc516ab09277e385ba57b38143fda`..`f5c3bbbbf73da70051dbfbd4a7f910660371c2ee` (`origin/main`..`HEAD`)
**Round**: 3 - full
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs` (node v24.22.1). Proofs re-run in **one** vitest invocation at HEAD `f5c3bbbbf73da70051dbfbd4a7f910660371c2ee` (`--reporter=verbose`), **without** a `-t` filter. Each named `it('…')` exists (`rg`) and appeared individually as `✓` (30 passed, 0 failed). Existing Consulta/chrome tests in the same file also ran and passed, including queued, success, fail, restore, chrome, late-answer race, and transport blip on GET by id.

Round 2 PASS was at `3dea9fa`. Production changed after that (`f5c3bbb` `fix(web): drop stale consulta fetches and keep jobs across transport blips`), so this round is full, not scoped.

Skipped under **light** (not forgotten): Binding sources step (ui) screen/arrangement enumeration, Coverage join, Test policy rows, fault injection.

No production code, tests, checklist, or task were edited.

## Binding sources

| Source                                            | Opened                                            | Contradiction                                             | Uncovered |
| ------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | --------- |
| step 1 (screens / ui)                             | skipped — profile light; no source marked binding | n/a                                                       | n/a       |
| https://github.com/oldboydev/sheldon/issues/56    | not opened as binding — checklist Sources only    | n/a                                                       | n/a       |
| https://github.com/oldboydev/sheldon/issues/58    | not opened as binding — checklist Sources only    | n/a                                                       | n/a       |
| https://github.com/oldboydev/sheldon/issues/61    | not opened as binding — checklist Sources only    | n/a                                                       | n/a       |
| `.tasks/issue-56-web-api-errors-consulta-job.md`  | yes — criteria 1–12                               | none vs C1–C12 / Landing (not binding)                    | n/a       |
| `.checks/issue-56-web-api-errors-consulta-job.md` | yes                                               | n/a — the checklist is the contract, not a binding design | n/a       |

## Checks

Named tests exist (`rg`) at HEAD `f5c3bbb`:

- `apps/web/test/app-shell.test.tsx:320` `it('refresh shows the API problem message instead of the generic vault fallback'`
- `apps/web/test/app-shell.test.tsx:333` `it('consulta submit shows an error notice without clearing the question'`
- `apps/web/test/app-shell.test.tsx:352` `it('fontes submit shows an error notice without clearing the input'`
- `apps/web/test/app-shell.test.tsx:368` `it('bundles submit shows an error notice without clearing the identifier'`
- `apps/web/test/app-shell.test.tsx:385` `it('consulta shows a Portuguese notice for an interrupted job'`
- `apps/web/test/app-shell.test.tsx:410` `it('consulta shows a Portuguese notice for a cancelled job'`
- `apps/web/test/app-shell.test.tsx:435` `it('consulta shows a stored answer when the tracked job is missing from the jobs page'`
- `apps/web/test/app-shell.test.tsx:455` `it('consulta keeps a visible answer when the answer GET fails'`
- `apps/web/test/app-shell.test.tsx:634` `it('fontes file drop submits without a path'`
- `apps/web/test/app-shell.test.tsx:650` `it('fontes file path submits without a dropped file'`
- `apps/web/test/app-shell.test.tsx:663` `it('fontes url and repository inputs stay required'`

C9–C11 line numbers shifted vs Round 2 because `f5c3bbb` inserted two extra `it()`s above them (late-answer race, transport blip on GET by id). Those extra tests ran in the same invocation and passed; they are not C1–C12 named proofs.

| Check | Claim                                                                                                                    | Proof run                                                                                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Result |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| C1    | Refresh with JSON `{ message, code }` on dashboard shows that `message` on `.notice.error`, not the vault fallback       | verbose vitest — `refresh shows the API problem message instead of the generic vault fallback` ✓ 5ms       | `apps/web/test/app-shell.test.tsx:327-330` `expect(container!.querySelector('.notice.error')?.textContent).toContain('O vault configurado não existe.')`; `expect(container!.textContent).not.toContain('Não foi possível ler o vault local.')`. Stub `:322-325` `dashboardError = { message: 'O vault configurado não existe.', code: 'VAULT_NOT_FOUND' }`.                                                                                                                                                                                     | PASS   |
| C2    | POST `/jobs` not-OK on Consulta shows `.notice.error` and keeps the question                                             | verbose vitest — `consulta submit shows an error notice without clearing the question` ✓ 9ms               | `:346` `expect(question.value).toBe('o que e harness')`; `:347-349` `.notice.error` `toContain('O tópico pedido não existe.')`.                                                                                                                                                                                                                                                                                                                                                                                                                  | PASS   |
| C3    | Fontes and Bundles submit catch the rejection, show `.notice.error`, and do not clear the input                          | verbose vitest — both named proofs ✓ 10ms / 8ms                                                            | Fontes `:362` `expect(url.value).toBe('https://example.com')`; `:363-365` `.notice.error` `toContain('Nenhum plugin aceitou esta entrada.')`. Bundles `:379` `expect((inputs[0] as HTMLInputElement).value).toBe('pack-1')`; `:380-382` `.notice.error` `toContain('O identificador do bundle é inválido.')`.                                                                                                                                                                                                                                    | PASS   |
| C4    | Tracked job is read by `GET /api/v1/jobs/:id`; missing from the first `GET /jobs` page does not show «Consulta na fila.» | verbose vitest — `consulta shows a stored answer when the tracked job is missing from the jobs page` ✓ 8ms | `:450` `toContain('## Wiki facts')`; `:452` `not.toContain('Consulta na fila.')`. Empty `stub.jobs` plus sessionStorage `jobId` forces the by-id lookup. Stub `:773-785` GET `/api/v1/jobs/:id` 404s `WEB_NOT_FOUND` when absent. Production `client.job` (`apps/web/src/client.generated.ts:83`, `App.tsx:468`); queued copy only when `currentJob?.status === 'queued'` (`App.tsx:527-528`). `currentJob` requires `trackedJob?.id === tracked.jobId` (`App.tsx:489-490`). `missing` only on `ApiProblem` `WEB_NOT_FOUND` (`App.tsx:476-479`). | PASS   |
| C5    | Job `interrupted` shows a Portuguese notice and not «Consulta na fila.»                                                  | verbose vitest — `consulta shows a Portuguese notice for an interrupted job` ✓ 8ms                         | `:406` `.notice.error` `toContain('interrompida')`; `:407` `not.toContain('Consulta na fila.')`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | PASS   |
| C6    | Job `cancelled` shows a Portuguese notice and not «Consulta na fila.»                                                    | verbose vitest — `consulta shows a Portuguese notice for a cancelled job` ✓ 8ms                            | `:431` `.notice.error` `toContain('cancelada')`; `:432` `not.toContain('Consulta na fila.')`. Checklist C6 names `cancelled` only; production also maps `cancelling` (`App.tsx:538-539`).                                                                                                                                                                                                                                                                                                                                                        | PASS   |
| C7    | With `answerId` and a stored `answer.json`, Consulta shows the card without the job on the first page                    | same proof as C4 — test ran and passed 8ms                                                                 | `:450-451` `toContain('## Wiki facts')` / `toContain('wiki/recall.md')`. Job list empty; GET-by-id 404 → `jobLookup === 'missing'` still loads the answer (`App.tsx:503-508`). Extra (not the named C7 proof): `:486` `consulta shows a stored answer when the interrupted job already wrote answer.json` ✓ 9ms — `:508` card + `:509` `interrompida`.                                                                                                                                                                                           | PASS   |
| C8    | Failed answer GET does not clear a visible card; shows a Portuguese notice                                               | verbose vitest — `consulta keeps a visible answer when the answer GET fails` ✓ 15ms                        | After `Atualizar` with `stub.answerFail`: `:479` still `toContain('## Wiki facts')`; `:480-482` `.notice.error` `toContain('Resposta não encontrada')`; `:483` `not.toContain('Consulta na fila.')`. Catch does not `setAnswer(undefined)` (`App.tsx:516-519`). Cleanup `cancelled` ignores a late GET (`App.tsx:509`, `:517`).                                                                                                                                                                                                                  | PASS   |
| C9    | File kind with a chosen `File` submits with the path input empty                                                         | verbose vitest — `fontes file drop submits without a path` ✓ 15ms                                          | `:641` `expect(path.value).toBe('')`; `:642` `expect(path.required).toBe(false)`; `:644-647` POST `/sources/upload` and POST `/jobs` both `true`. Production `required={kind !== 'file' \|\| file === undefined}` (`App.tsx:338`).                                                                                                                                                                                                                                                                                                               | PASS   |
| C10   | File kind with only a path (no file) still submits                                                                       | verbose vitest — `fontes file path submits without a dropped file` ✓ 12ms                                  | `:660` `expect(fetches.some((item) => item.method === 'POST' && item.url.endsWith('/jobs'))).toBe(true)`.                                                                                                                                                                                                                                                                                                                                                                                                                                        | PASS   |
| C11   | URL and repository keep the text field `required`                                                                        | verbose vitest — `fontes url and repository inputs stay required` ✓ 8ms                                    | `:668` default URL `expect(path.required).toBe(true)`; `:670` repository `true`; `:672` URL again `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                        | PASS   |
| C12   | Fontes upload / probe / `queueJob` failure shows `.notice.error` in Portuguese                                           | same proof as C3 Fontes — test ran and passed 10ms                                                         | `:363-365` `.notice.error` `toContain('Nenhum plugin aceitou esta entrada.')`. Exercises `queueJob` (`jobsPostError`); upload and probe share the same `catch` (`App.tsx:285-286`).                                                                                                                                                                                                                                                                                                                                                              | PASS   |

Residual (do not fail the gate): C4/C7 assert the card and the absence of «Consulta na fila.», not the GET URL string; C12’s named proof is `queueJob`, not a separate upload or probe 4xx; C6’s named proof is `cancelled`, not `cancelling`. Extra tests added before `f5c3bbb` (`:486` interrupted `answer.json`, `:513` second-query isolation, `:544` TypeError → Portuguese fallback) and in `f5c3bbb` (`:561` late-answer race, `:604` transport blip on GET by id) ran and passed in the same file; they are not C1–C12 named proofs.

Existing tests in `app-shell.test.tsx` (queued, succeeded card, fail, restore, chrome, late-answer race, transport blip on GET by id, plus the rest of the file) also ran individually as `✓` in the same invocation.

## Swept (`existing` re-read against code at HEAD)

n/a / check-mapped rows are proven in the Checks table. `existing` constraints re-read in production at `f5c3bbb`:

| Row            | Cited constraint                                     | In code?                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| idempotency    | existing — refresh 3s; GET by id is a read           | yes — `apps/web/src/App.tsx:79` `setInterval(() => void refresh(), 3_000)`; `apps/web/src/client.generated.ts:83` `job: (id) => request<Job>(\`/jobs/${encodeURIComponent(id)}\`)` is GET                                                                                                                                                                                                                   |
| authorization  | existing — origin/host loopback                      | yes — `apps/web/src/server.ts:45` `!isLocalHost(host) \|\| !isAllowedOrigin(...)`; `:381-396` loopback host and same-host `http:` origin. Untouched in this diff                                                                                                                                                                                                                                            |
| concurrency    | existing — one tracked job; newest GET wins          | yes — single `tracked` (`App.tsx:457`); job lookup effect `:464-487` `cancelled` flag so a stale `client.job` response does not apply; deps `[tracked, jobs]`. `currentJob` only when `trackedJob?.id === tracked.jobId` (`:489-490`). `f5c3bbb` also: answer GET cleanup `cancelled` (`:509`, `:517`); transport/`TypeError` on GET by id leaves `jobLookup` `idle` without clearing `trackedJob` (`:481`) |
| data lifecycle | existing — `sessionStorage` `sheldon-web-last-query` | yes — `App.tsx:381` `lastQueryKey = 'sheldon-web-last-query'`; `:400` `getItem`; `:575` `setItem` on successful Consulta submit                                                                                                                                                                                                                                                                             |

## Coverage

no Coverage recompute — profile light

## Test policy rows

no Test policy section required — profile light

## Faults injected

no faults injected — profile light

## Gate

Proofs (one vitest invocation at HEAD `f5c3bbbbf73da70051dbfbd4a7f910660371c2ee`, full file, no `-t` filter):

```text
npx vitest run apps/web/test/app-shell.test.tsx --reporter=verbose
```

30 passed, 0 failed. Each named C1–C12 proof appeared individually as `✓`. Existing tests in that file (queued, success, fail, restore, chrome, late-answer race, transport blip on GET by id, and the rest) also ran and passed. Exit 0.

Verbose hits for the named proofs:

```text
✓ refresh shows the API problem message instead of the generic vault fallback 5ms
✓ consulta submit shows an error notice without clearing the question 9ms
✓ fontes submit shows an error notice without clearing the input 10ms
✓ bundles submit shows an error notice without clearing the identifier 8ms
✓ consulta shows a Portuguese notice for an interrupted job 8ms
✓ consulta shows a Portuguese notice for a cancelled job 8ms
✓ consulta shows a stored answer when the tracked job is missing from the jobs page 8ms
✓ consulta keeps a visible answer when the answer GET fails 15ms
✓ fontes file drop submits without a path 15ms
✓ fontes file path submits without a dropped file 12ms
✓ fontes url and repository inputs stay required 8ms
```

Optional extra (not a substitute for the full app-shell file):

```text
npx vitest run apps/web/test/review-view.test.tsx --reporter=verbose
```

14 passed, 0 failed. Exit 0.

CONTRIBUTING applicable gates, run by this verifier at HEAD `f5c3bbb` (working tree clean except this report):

```text
npx prettier --check .checks/issue-56-web-api-errors-consulta-job.md .tasks/issue-56-web-api-errors-consulta-job.md CHANGELOG.md README.md apps/web/src/App.tsx apps/web/src/client.generated.ts apps/web/test/app-shell.test.tsx
```

Exit 0. "All matched files use Prettier code style!"

```text
npx eslint apps/web/src/client.generated.ts apps/web/src/App.tsx apps/web/test/app-shell.test.tsx
```

Exit 0.

```text
npx tsc --noEmit
```

Exit 0.

```text
npx markdownlint-cli2 ".checks/issue-56-web-api-errors-consulta-job.md" ".tasks/issue-56-web-api-errors-consulta-job.md" "README.md" "CHANGELOG.md"
```

Exit 0. Finding: `.checks/issue-56-web-api-errors-consulta-job.md .tasks/issue-56-web-api-errors-consulta-job.md README.md CHANGELOG.md !test-fixtures/okf/** !**/node_modules/**`. Linting: 4 files. Summary: 0 issues in 0 files.

```text
npm run lint:repo
```

Exit 0.

```text
git diff --check
git diff --check origin/main..HEAD
```

Exit 0 / exit 0.
