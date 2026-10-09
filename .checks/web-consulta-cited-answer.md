# Show cited query answer on Consulta

Sources:

- conversation 2026-10-09 - **binding for the interface**: Consulta queues `type: query`
  then only shows "Consulta adicionada à fila."; the cited text lives in
  `outputs/answers/<id>/answer.json` and is not on the screen. Agreed flow: in-page
  status via the existing 3s job poll (fila → execução → card); no OS/browser
  Notification; wiki stays closed (no promote / write-back in this slice)
- `.archify/workflow-consulta-resposta-citada-20261009-095416/candidate.json` - GET
  answer is new; QueryService + `JsonCommandExecutor` spawn stay as they are
- `docs/prds/009-local-web-interface.md` - area 5 Consulta: pergunta e resposta citada
- `.interface-design/system.md` - one magenta CTA; notices use `--info` / `--erro`;
  pt-BR

Profile: `light` (no `AGENTS.md` declaration). Handoff: one batch.

## Out of scope

- Promote `answer.json` to a proposal (`sheldon answer`) - later slice
- OS toast / `Notification` API
- Search lexical (`GET /api/v1/search`)
- SSE `GET /api/v1/jobs/:id/events` instead of the 3s poll
- Writing wiki from Consulta
- Changing agent spawn (`JsonCommandExecutor`)

## Landing

Reuse `QueryAnswerStore.load` and the App 3s `client.jobs()` refresh. Add a read-only
GET. Persist the last query in `sessionStorage` because `QueryView` unmounts when the
section changes.

| One-way door                         | Literal shape                                                                                    | Alternative rejected                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Cited answer has its own GET         | `GET /api/v1/entities/{kind}/{slug}/answers/{id}` returns the stored `QueryAnswer` JSON          | stuffing `text` onto `Job` — jobs stay operational records, answers stay vault files |
| Last query survives leaving Consulta | `sessionStorage` key `sheldon-web-last-query` `{ jobId, answerId, kind, slug, question, agent }` | in-memory only — QueryView unmounts on section change and the card would vanish      |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Answer HTTP · 3 files · ~12 KB · ~3k

**C1** - `GET /api/v1/entities/topic/memory/answers/answer-001` returns 200 with
`id` `answer-001`, `question` `What is recall?`, `agent` `grok`, `text` containing
`## Wiki facts`, and `concepts[0].path` `wiki/recall.md`
Proof: `npx vitest run apps/web/test/server.test.ts -t "reads a stored query answer for a topic"`

**C2** - The same route returns 404 `WEB_NOT_FOUND` when `answer.json` is missing, and
400 `WEB_REQUEST_INVALID` when the id is `../secret`
Proof: `npx vitest run apps/web/test/server.test.ts -t "rejects missing and invalid query answer ids"`

### S2 - Consulta card · 3 files · ~20 KB · ~5k

**C3** - After submitting a Consulta, the page shows `Consulta na fila.` (not only the
old one-shot "Consulta adicionada à fila.")
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows in-page queued status after submit"`

**C4** - When the tracked query job is `succeeded`, Consulta fetches the answer and
renders the question, the agent `Grok`, a citation `wiki/recall.md`, and body text
`## Wiki facts`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows cited answer when the query job succeeds"`

**C5** - When the tracked query job is `failed` with
`The agent command did not produce a valid cited query answer.`, Consulta shows a
Portuguese notice that the agent did not return a valid cited answer, not the English
executor string
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows job error when the query fails"`

**C6** - With `sheldon-web-last-query` in `sessionStorage` pointing at a succeeded job
and a stored answer, opening Consulta shows the cited card without posting `/jobs`,
and the form question/agent match the stored query
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta restores the last cited answer from sessionStorage"`

**C7** - When the tracked query job fails with `Proposal is invalid:` plus missing
Wiki facts/Inferences/Gaps sections and a duplicate wiki citation, Consulta shows
Portuguese `Sheldon não gravou a resposta` and `Tente de novo`, without `Proposal is invalid`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta translates grok query-answer validation failure into Portuguese"`

## Swept

- validation: C2
- failure modes: C5, C7
- idempotency: C6 - restore does not enqueue again
- authorization: existing loopback origin gate
- concurrency: not in scope - one tracked job
- data lifecycle: C1 reads vault file; no extra store
- dependency failure: C5
- state transitions: C3 queued, C4 succeeded, C5 failed, C7 validation failed
- observability: not in scope

## Coverage

| Set (size)                       | Member -> proof                                      | Unproven |
| -------------------------------- | ---------------------------------------------------- | -------- |
| job status shown on Consulta (4) | queued C3 · succeeded C4 · failed C5 · validation C7 | -        |
| GET answer outcomes (3)          | 200 C1 · 404 C2 · 400 C2                             | -        |

- Claims naming a status code, route or response shape: C1, C2
- No other check claims more than the single case its proof exercises

## Handoff

S1-S2 = one batch (~8k). Surface is `apps/web` only.
