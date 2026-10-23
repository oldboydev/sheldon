<!-- markdownlint-disable MD034 MD060 -->

# Web API errors, Consulta job tracking, Fontes file drop Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `d68e2bef537dc516ab09277e385ba57b38143fda`..`76624efeee1e7ded2283c970d844840b8884e561` (`origin/main`..`HEAD`)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs`. Proofs run in **one** vitest invocation at HEAD `76624ef` (`--reporter=verbose`). Each named `it('…')` exists (`rg`) and appeared individually as `✓` (11 passed, 0 failed, 14 skipped by filter).

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

Named tests exist (`rg`) at HEAD `76624ef`:

- `apps/web/test/app-shell.test.tsx:320` `it('refresh shows the API problem message instead of the generic vault fallback'`
- `apps/web/test/app-shell.test.tsx:333` `it('consulta submit shows an error notice without clearing the question'`
- `apps/web/test/app-shell.test.tsx:352` `it('fontes submit shows an error notice without clearing the input'`
- `apps/web/test/app-shell.test.tsx:368` `it('bundles submit shows an error notice without clearing the identifier'`
- `apps/web/test/app-shell.test.tsx:385` `it('consulta shows a Portuguese notice for an interrupted job'`
- `apps/web/test/app-shell.test.tsx:410` `it('consulta shows a Portuguese notice for a cancelled job'`
- `apps/web/test/app-shell.test.tsx:435` `it('consulta shows a stored answer when the tracked job is missing from the jobs page'`
- `apps/web/test/app-shell.test.tsx:455` `it('consulta keeps a visible answer when the answer GET fails'`
- `apps/web/test/app-shell.test.tsx:486` `it('fontes file drop submits without a path'`
- `apps/web/test/app-shell.test.tsx:502` `it('fontes file path submits without a dropped file'`
- `apps/web/test/app-shell.test.tsx:515` `it('fontes url and repository inputs stay required'`

| Check | Claim                                                                                                                    | Proof run                                                                                                  | Evidence                                                                                                                                                                                                                                                                                                                                                     | Result |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| C1    | Refresh with JSON `{ message, code }` on dashboard shows that `message` on `.notice.error`, not the vault fallback       | verbose vitest — `refresh shows the API problem message instead of the generic vault fallback` ✓ 33ms      | `apps/web/test/app-shell.test.tsx:327-330` `expect(container!.querySelector('.notice.error')?.textContent).toContain('O vault configurado não existe.')`; `expect(container!.textContent).not.toContain('Não foi possível ler o vault local.')`. Stub `:322-325` `dashboardError = { message: 'O vault configurado não existe.', code: 'VAULT_NOT_FOUND' }`. | PASS   |
| C2    | POST `/jobs` not-OK on Consulta shows `.notice.error` and keeps the question                                             | verbose vitest — `consulta submit shows an error notice without clearing the question` ✓ 27ms              | `:346` `expect(question.value).toBe('o que e harness')`; `:347-349` `.notice.error` `toContain('O tópico pedido não existe.')`.                                                                                                                                                                                                                              | PASS   |
| C3    | Fontes and Bundles submit catch the rejection, show `.notice.error`, and do not clear the input                          | verbose vitest — both named proofs ✓ 21ms / 13ms                                                           | Fontes `:362` `expect(url.value).toBe('https://example.com')`; `:363-365` `.notice.error` `toContain('Nenhum plugin aceitou esta entrada.')`. Bundles `:379` `expect((inputs[0] as HTMLInputElement).value).toBe('pack-1')`; `:380-382` `.notice.error` `toContain('O identificador do bundle é inválido.')`.                                                | PASS   |
| C4    | Tracked job is read by `GET /api/v1/jobs/:id`; missing from the first `GET /jobs` page does not show «Consulta na fila.» | verbose vitest — `consulta shows a stored answer when the tracked job is missing from the jobs page` ✓ 9ms | `:450` `toContain('## Wiki facts')`; `:452` `not.toContain('Consulta na fila.')`. Empty `stub.jobs` plus sessionStorage `jobId` forces the by-id lookup (`client.job`); stub `:613-617` 404s that GET. Queued copy only when `trackedJob?.status === 'queued'` (`App.tsx:496-498`).                                                                          | PASS   |
| C5    | Job `interrupted` shows a Portuguese notice and not «Consulta na fila.»                                                  | verbose vitest — `consulta shows a Portuguese notice for an interrupted job` ✓ 22ms                        | `:406` `.notice.error` `toContain('interrompida')`; `:407` `not.toContain('Consulta na fila.')`.                                                                                                                                                                                                                                                             | PASS   |
| C6    | Job `cancelled` shows a Portuguese notice and not «Consulta na fila.»                                                    | verbose vitest — `consulta shows a Portuguese notice for a cancelled job` ✓ 11ms                           | `:431` `.notice.error` `toContain('cancelada')`; `:432` `not.toContain('Consulta na fila.')`. Checklist C6 names `cancelled` only; production also maps `cancelling` (`App.tsx:508-509`).                                                                                                                                                                    | PASS   |
| C7    | With `answerId` and a stored `answer.json`, Consulta shows the card without the job on the first page                    | same proof as C4 — test ran and passed 9ms                                                                 | `:450-451` `toContain('## Wiki facts')` / `toContain('wiki/recall.md')`. Job list empty; GET-by-id 404 → `jobLookup === 'missing'` still loads the answer.                                                                                                                                                                                                   | PASS   |
| C8    | Failed answer GET does not clear a visible card; shows a Portuguese notice                                               | verbose vitest — `consulta keeps a visible answer when the answer GET fails` ✓ 16ms                        | After `Atualizar` with `stub.answerFail`: `:479` still `toContain('## Wiki facts')`; `:480-482` `.notice.error` `toContain('Resposta não encontrada')`; `:483` `not.toContain('Consulta na fila.')`. Catch does not `setAnswer(undefined)` (`App.tsx:490-492`).                                                                                              | PASS   |
| C9    | File kind with a chosen `File` submits with the path input empty                                                         | verbose vitest — `fontes file drop submits without a path` ✓ 19ms                                          | `:493` `expect(path.value).toBe('')`; `:494` `expect(path.required).toBe(false)`; `:496-499` POST `/sources/upload` and POST `/jobs` both `true`.                                                                                                                                                                                                            | PASS   |
| C10   | File kind with only a path (no file) still submits                                                                       | verbose vitest — `fontes file path submits without a dropped file` ✓ 13ms                                  | `:512` `expect(fetches.some((item) => item.method === 'POST' && item.url.endsWith('/jobs'))).toBe(true)`.                                                                                                                                                                                                                                                    | PASS   |
| C11   | URL and repository keep the text field `required`                                                                        | verbose vitest — `fontes url and repository inputs stay required` ✓ 9ms                                    | `:520` default URL `expect(path.required).toBe(true)`; `:522` repository `true`; `:524` URL again `true`.                                                                                                                                                                                                                                                    | PASS   |
| C12   | Fontes upload / probe / `queueJob` failure shows `.notice.error` in Portuguese                                           | same proof as C3 Fontes — test ran and passed 21ms                                                         | `:363-365` `.notice.error` `toContain('Nenhum plugin aceitou esta entrada.')`. Exercises `queueJob` (`jobsPostError`); upload and probe share the same `catch` (`App.tsx:279-280`).                                                                                                                                                                          | PASS   |

Residual (do not fail the gate): C4/C7 assert the card and the absence of «Consulta na fila.», not the GET URL string; C12’s named proof is `queueJob`, not a separate upload or probe 4xx.

## Swept (`existing` re-read against code at HEAD)

n/a / check-mapped rows are proven in the Checks table. `existing` constraints re-read in production:

| Row            | Cited constraint                                     | In code?                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| idempotency    | existing — refresh 3s; GET by id is a read           | yes — `apps/web/src/App.tsx:73` `setInterval(() => void refresh(), 3_000)`; `apps/web/src/client.generated.ts:83` `job: (id) => request<Job>(\`/jobs/${encodeURIComponent(id)}\`)` is GET |
| authorization  | existing — origin/host loopback                      | yes — `apps/web/src/server.ts:45` `!isLocalHost(host) \|\| !isAllowedOrigin(...)`; `:381-396` loopback host and same-host `http:` origin. Untouched in this diff                          |
| concurrency    | existing — one tracked job; newest GET wins          | yes — single `tracked` (`App.tsx:449`); job lookup effect `:458-474` `cancelled` flag so a stale `client.job` response does not apply; deps `[tracked, jobs]`                             |
| data lifecycle | existing — `sessionStorage` `sheldon-web-last-query` | yes — `App.tsx:375` `lastQueryKey = 'sheldon-web-last-query'`; `:394` `getItem`; `:543` `setItem` on successful Consulta submit                                                           |

## Coverage

no Coverage recompute — profile light

## Test policy rows

no Test policy section required — profile light

## Faults injected

no faults injected — profile light

## Gate

Proofs (one vitest invocation at HEAD `76624efeee1e7ded2283c970d844840b8884e561`):

```text
npx vitest run apps/web/test/app-shell.test.tsx -t "refresh shows the API problem message instead of the generic vault fallback|consulta submit shows an error notice without clearing the question|fontes submit shows an error notice without clearing the input|bundles submit shows an error notice without clearing the identifier|consulta shows a stored answer when the tracked job is missing from the jobs page|consulta shows a Portuguese notice for an interrupted job|consulta shows a Portuguese notice for a cancelled job|consulta keeps a visible answer when the answer GET fails|fontes file drop submits without a path|fontes file path submits without a dropped file|fontes url and repository inputs stay required" --reporter=verbose
```

11 passed, 0 failed, 14 skipped (filter). Each named proof appeared individually as `✓`. Exit 0.

CONTRIBUTING applicable gates, run by this verifier at HEAD `76624ef` (working tree clean):

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

Exit 0. "Summary: 0 issues in 0 files".

```text
npm run lint:repo
```

Exit 0. Working tree clean — change-policy no-op on this HEAD.

```text
git diff --check
git diff --check origin/main..HEAD
```

Exit 0 / exit 0.
