<!-- markdownlint-disable MD029 MD034 MD060 -->

# Issue 57 — Início conta só as 12 jobs mais novas

> Build this with **tlc-implement**, profile light.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Em `sheldon web`, os tiles do Início «Na fila / Em execução / Precisam de atenção»
contam a partir de `database.listJobs(12).jobs` — só as 12 jobs mais novas
(`created_at DESC`). Um vault com 12 sucessos recentes e jobs `queued` / `failed`
mais antigas mostra `queued: 0` e `failed: 0` embora essas jobs ainda existam em
`operations.db`. Quem usa Início para ver se há trabalho parado vê zeros e
ignora falhas e fila reais. A issue não dá volume. Conferido em
`apps/web/src/server.ts` (`dashboard`) e
`packages/persistence/src/operations-db.ts` (`listJobs`).

Os tiles passam a reflectir o estado actual de todas as jobs do vault. A lista
«Atividade recente» continua a ser um recorte das jobs mais novas.

4 criteria in 1 slice · 0 one-way doors · 0 open, of which 0 block

Sizing evidence: CONTRIBUTING does not declare task size; GitHub issue #57 is one
bug; default is one task.

## Criteria

### Contagens do Início

1. Dado um vault com mais de 12 jobs `succeeded` mais novas e uma `failed` mais
   antiga, quando GET `/api/v1/dashboard`, então `jobs.failed >= 1`. As
   contagens `queued` / `running` (inclui `cancelling`) / `failed` vêm de uma
   query por estado, ou de um scan que não corta nas 12 mais novas.
2. Sempre, `activity` de GET `/api/v1/dashboard` é um recorte das jobs mais
   novas, com no máximo 12 itens.
3. Sempre, `apps/web/test/server.test.ts` cobre o vault com mais de 12 sucessos
   recentes e uma falha antiga: `jobs.failed >= 1`.
4. Sempre, esta raia não adiciona UI de cancel/retry nem SSE no Início, e GET
   `/api/v1/jobs` sem `limit` continua a paginar com omissão 100, não 12.

## Out of scope

- UI de cancel/retry e SSE no Início — issue #57.
- Mudar o tamanho da página de GET `/api/v1/jobs` — issue #57.
- Preview stale da Revisão — issue #59 (fechada).
- Code-review Windows EPERM TEMP — issue #48.
- Publicar npm 0.2.12.

## Observable

| Surface                     | Decision                    | Landing                                  |
| --------------------------- | --------------------------- | ---------------------------------------- |
| screen Início               | tiles Na fila / execução / atenção | 1, 3                              |
| screen Início               | Atividade recente           | 2                                        |
| screen Início               | empty / loading / error     | existing - tiles `—` até o dashboard; banner de vault |
| screen Início               | unauthorised                | n/a - loopback já existente              |
| screen Início               | destructive action confirms | n/a - Início não cancela nem retenta     |
| API `GET /api/v1/dashboard` | response shape              | 1, 2 — campos `jobs` e `activity` iguais |
| API `GET /api/v1/jobs`      | page size                   | 4 — omissão 100, máximo 250              |
| document README / CHANGELOG | copy                        | 1, 2                                     |

## Swept

- validation: n/a - GET sem corpo novo
- failure modes: existing - `VaultService.discover` e sqlite health já cobrem vault/sqlite
- idempotency and retry: n/a - GET idempotente; sem escrita
- authorization: existing - origin/host loopback
- concurrency and ordering: n/a - leitura; `listJobs` continua `created_at DESC, id DESC`
- data lifecycle: n/a - sem schema nem backfill; jobs já estão em `operations.db`
- external-dependency failure: existing - sqlite `checkHealth` no dashboard
- state transitions: n/a - não altera `JobStatus`
- observability: 1 - tiles passam a mostrar a fila/falha reais

## Impact

| Front       | What changes                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| domain      | existing term: `dashboard.jobs.queued` / `running` / `failed` passa a contar todas as jobs do vault, não só as 12 mais novas — `DashboardView` e `app-shell` já lêem esses campos |
| stored data | nothing to migrate                                                                                    |

## Decided

None - a query `COUNT` por `status` (ou um scan sem o recorte de 12) é um método
reversível em `OperationsDatabase`, ao lado de `listJobs`. Sem schema, contrato
novo nem padrão que o código ainda não tenha. A issue já fixa os três campos e
que `running` inclui `cancelling`.

## Surface

| Route                    | In | Out                                         | Status | Criteria |
| ------------------------ | -- | ------------------------------------------- | ------ | -------- |
| `GET /api/v1/dashboard`  | —  | `jobs.queued`, `jobs.running`, `jobs.failed`, `activity` | 200    | 1, 2, 3  |
| `GET /api/v1/jobs`       | `limit`, `offset` | `jobs`, `nextOffset`                  | 200    | 4        |

## Sources

- https://github.com/oldboydev/sheldon/issues/57 - comportamento, critérios, fora de escopo
- Conversação 2026-10-24 - «pode fazer a proxima raia»; uma entrega, um PR, só
  #57; sem push até o proprietário pedir

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
