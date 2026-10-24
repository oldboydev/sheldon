<!-- markdownlint-disable MD034 MD060 -->

# Issue 57 — Início conta só as 12 jobs mais novas

Sources:

- https://github.com/oldboydev/sheldon/issues/57 - **binding**: contagens
  `queued` / `running` (inclui `cancelling`) / `failed` por estado, sem cortar
  nas 12 mais novas; `activity` continua recorte das mais novas; teste de
  servidor com >12 sucessos recentes e falha antiga (`jobs.failed >= 1`); sem
  UI de cancel/retry, SSE, nem mudança do page-size de GET `/jobs`
- `.tasks/issue-57-web-dashboard-job-counts.md` - critérios 1–4

## Out of scope

- UI de cancel/retry e SSE no Início
- Mudar o tamanho da página de GET `/api/v1/jobs`
- Issues #59 (fechada), #48; publicar npm 0.2.12

## Landing

`dashboard()` em `apps/web/src/server.ts` já devolve `jobs.queued` / `running` /
`failed` e `activity`. Esta raia deixa de filtrar esses três números a partir de
`listJobs(12)` e passa a lê-los de uma query `COUNT` por `status` em
`OperationsDatabase`. `activity` continua `listJobs(12)`. GET `/api/v1/jobs`
mantém omissão 100 / máximo 250.

| One-way door | Literal shape                                                                                       | Alternative rejected                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None         | `COUNT`/`GROUP BY status` no SQLite já existente; `running` do dashboard = `running` + `cancelling` | varrer todas as linhas em memória, ou subir o `listJobs(12)` do dashboard — a issue pede query por estado; alargar o recorte ainda esconde jobs para além do novo limite |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Contagens do Início · server.ts + operations-db.ts + server.test.ts · ~18 KB · ~5k

**C1** - Dado um vault com mais de 12 jobs `succeeded` mais novas e uma `failed`
mais antiga, quando GET `/api/v1/dashboard`, então `jobs.failed >= 1`. As
contagens `queued` / `running` (inclui `cancelling`) / `failed` vêm de uma query
por estado, ou de um scan que não corta nas 12 mais novas.
Proof: `npx vitest run apps/web/test/server.test.ts -t "dashboard job counts include older queued running and failed jobs past the newest twelve"`
Proof: `npx vitest run packages/persistence/test/operations-db.test.ts -t "counts jobs by status without cutting at the newest twelve"`

**C2** - Sempre, `activity` de GET `/api/v1/dashboard` é um recorte das jobs mais
novas, com no máximo 12 itens.
Proof: `npx vitest run apps/web/test/server.test.ts -t "dashboard job counts include older queued running and failed jobs past the newest twelve"`

**C3** - Sempre, `apps/web/test/server.test.ts` cobre o vault com mais de 12
sucessos recentes e uma falha antiga: `jobs.failed >= 1`.
Proof: `npx vitest run apps/web/test/server.test.ts -t "dashboard job counts include older queued running and failed jobs past the newest twelve"`

**C4** - Sempre, esta raia não adiciona UI de cancel/retry nem SSE no Início, e
GET `/api/v1/jobs` sem `limit` continua a paginar com omissão 100, não 12.
Proof: `npx vitest run apps/web/test/server.test.ts -t "dashboard job counts include older queued running and failed jobs past the newest twelve"`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "inicio tiles bind dashboard jobs and vault health and nova fonte opens fontes"`

## Handoff

S1 = um batch (~5k). Mesmo `server.ts`, `operations-db.ts` e os testes nomeados.
Sem handoff.

## Swept

- validation: n/a - GET sem corpo novo
- failure modes: existing - discover + sqlite health
- idempotency: n/a - GET idempotente
- authorization: existing - origin loopback
- concurrency: n/a - leitura
- data lifecycle: n/a - sem schema
- dependency failure: existing - sqlite checkHealth
- state transitions: n/a - não altera JobStatus
- observability: C1
