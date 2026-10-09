# Show cited query answer on Consulta Verification

**Verdict**: PASS
**Profile**: light (no `AGENTS.md` in this repo)
**Diff range**: `79a94bd0548a7999b485a3b60cc432814db0aac3`..`2ccd6986f38f971d7bc51024852df44b4b78bfaf` (`origin/main`..`HEAD`)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

## Binding sources

Step 1 designed-screens enumeration skipped — profile light, not forgotten. Sources were opened and compared for contradictions only.

| Source | Opened | Contradiction | Uncovered |
|---|---|---|---|
| conversation 2026-10-09 (**binding for the interface**; encoded in checklist) | yes — checklist Sources + Landing | none. C3 in-page `Consulta na fila.` (not one-shot “Consulta adicionada à fila.”); C4 card after succeeded poll; C5 job error in `.notice.error`; no Notification; wiki write-back out of scope | Step 1 skipped — profile light. Conversation names fila → execução → card; C3/C4/C5 cover queued / succeeded / failed, not running copy |
| `.archify/workflow-consulta-resposta-citada-20261009-095416/candidate.json` | yes | none. GET answer is new (C1/C2); QueryService + `JsonCommandExecutor` stay out of scope; in-page alerta, no SO toast | Step 1 skipped — profile light |
| `docs/prds/009-local-web-interface.md` area 5 | yes | none. Area 5 names pergunta e resposta citada; write-back is a later slice (Out of scope), matching the conversation | Step 1 skipped — profile light |
| `.interface-design/system.md` | yes | none. One magenta CTA (`btn--primary`); notices use `--info` / `--erro` (`.notice` / `.notice.error`); Consulta chrome is pt-BR | Step 1 skipped — profile light |

## Checks

| Check | Claim | Proof run | Evidence | Result |
|---|---|---|---|---|
| C1 | `GET /api/v1/entities/topic/memory/answers/answer-001` 200 with `id` `answer-001`, `question` `What is recall?`, `agent` `grok`, `text` containing `## Wiki facts`, `concepts[0].path` `wiki/recall.md` | `server.test.ts` verbose ✓ | `apps/web/test/server.test.ts:409` `expect(response.statusCode).toBe(200)`; `:410-415` `toMatchObject({ id: 'answer-001', question: 'What is recall?', agent: 'grok', concepts: [{ path: 'wiki/recall.md' }] })`; `:416` `expect(response.json().text).toContain('## Wiki facts')` | PASS |
| C2 | same route 404 `WEB_NOT_FOUND` when missing; 400 `WEB_REQUEST_INVALID` when id is `../secret` | `server.test.ts` verbose ✓ | `apps/web/test/server.test.ts:427-428` `expect(missing.statusCode).toBe(404)` / `toMatchObject({ code: 'WEB_NOT_FOUND' })`; `:433-434` `expect(invalid.statusCode).toBe(400)` / `toMatchObject({ code: 'WEB_REQUEST_INVALID' })` (inject path encodes `../secret` at `:431`) | PASS |
| C3 | after submit, page shows `Consulta na fila.` and not only “Consulta adicionada à fila.” | `app-shell.test.tsx` verbose ✓ | `apps/web/test/app-shell.test.tsx:155` `expect(container!.textContent).toContain('Consulta na fila.')`; `:156` `expect(container!.textContent).not.toContain('Consulta adicionada à fila.')` | PASS |
| C4 | succeeded query job: question, agent `Grok`, citation `wiki/recall.md`, body `## Wiki facts` | `app-shell.test.tsx` verbose ✓ | `apps/web/test/app-shell.test.tsx:179-182` `toContain('What is recall?')` / `'Grok'` / `'wiki/recall.md'` / `'## Wiki facts'` | PASS |
| C5 | failed job error `The agent command did not produce a valid cited query answer.` in `.notice.error` | `app-shell.test.tsx` verbose ✓ | `apps/web/test/app-shell.test.tsx:202-205` `container!.querySelector('.notice.error')`; `expect(notice?.textContent).toContain('The agent command did not produce a valid cited query answer.')` | PASS |
| C6 | `sheldon-web-last-query` restore shows cited card without posting `/jobs` | `app-shell.test.tsx` verbose ✓ | `apps/web/test/app-shell.test.tsx:230-234` `toContain('## Wiki facts')` / `'wiki/recall.md'`; `expect(fetches.some((item) => item.method === 'POST' && item.url.endsWith('/jobs'))).toBe(false)` | PASS |

Each named test exists (`rg`) and appeared individually as `✓` in the one vitest invocation at `HEAD` `2ccd6986f38f971d7bc51024852df44b4b78bfaf`.

## Swept (existing rows re-read against code)

| Row | Cited constraint | Present |
|---|---|---|
| validation | C2 | yes — proven at `server.test.ts:427-434` |
| failure modes | C5 | yes — proven at `app-shell.test.tsx:202-205` |
| idempotency | C6 restore does not enqueue again | yes — proven at `app-shell.test.tsx:232-234` |
| authorization | existing loopback origin gate | yes — `apps/web/src/server.ts:43-57` `onRequest` hook: `isLocalHost` / `isAllowedOrigin`; 421 `WEB_LOCAL_ORIGIN_REQUIRED` |
| concurrency | not in scope | n/a |
| data lifecycle | C1 reads vault file | yes — proven at `server.test.ts:409-416` |
| dependency failure | C5 | yes — same as failure modes |
| state transitions | C3 queued, C4 succeeded, C5 failed | yes — proven at the C3–C5 citations |
| observability | not in scope | n/a |

Rows marked not-in-scope were not re-litigated.

## Coverage

no Coverage recompute — profile light

## Test policy rows

no Test policy section required — profile light

## Faults injected

no faults injected — profile light

## Gate

```text
npx vitest run apps/web/test/server.test.ts apps/web/test/app-shell.test.tsx -t "reads a stored query answer for a topic|rejects missing and invalid query answer ids|consulta shows in-page queued status after submit|consulta shows cited answer when the query job succeeds|consulta shows job error when the query fails|consulta restores the last cited answer from sessionStorage" --reporter=verbose
```

6 passed, 0 failed, 22 skipped (filter). Each named proof appeared individually as `✓` at `HEAD` `2ccd6986f38f971d7bc51024852df44b4b78bfaf`.

Residual (do not fail the gate): conversation / UI copy `Consulta em execução.` has no named check (Coverage set is queued / succeeded / failed only); C4 asserts rendered card text, not the GET URL string.
