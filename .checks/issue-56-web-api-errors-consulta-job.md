<!-- markdownlint-disable MD034 MD060 -->

# Web API errors, Consulta job tracking, Fontes file drop

Sources:

- https://github.com/oldboydev/sheldon/issues/56 - JSON lançado como objeto, banner e submits
- https://github.com/oldboydev/sheldon/issues/58 - job da Consulta fora da página / interrupted
- https://github.com/oldboydev/sheldon/issues/61 - drop de arquivo sem caminho
- `.tasks/issue-56-web-api-errors-consulta-job.md` - critérios 1–12

## Out of scope

- Compile na web, busca lexical, promote, cancel/retry, SSE, Notification
- Separar Verificar/Iniciar; `--stt`/OCR/cookies/language na UI
- Issues #59, #57, #48

## Landing

`client.request` lança `ApiProblem extends Error` com a `message` do JSON. `QueryView`
lê `GET /jobs/:id`. Fontes tira `required` do caminho quando há `File`. Submits têm
`catch` e `.notice.error`.

| One-way door                                  | Literal shape                                       | Alternative rejected                            |
| --------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| Cliente lança `Error` com a `message` do JSON | `ApiProblem extends Error` em `client.generated.ts` | Lançar o objeto JSON; mapear cada `code` no App |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Erros da API · client.generated.ts + App.tsx · ~18k

**C1** - Refresh com JSON `{ message, code }` no dashboard mostra essa `message` no banner,
não o fallback do vault.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "refresh shows the API problem message instead of the generic vault fallback"`

**C2** - POST `/jobs` não-OK na Consulta mostra `.notice.error` e mantém a pergunta.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta submit shows an error notice without clearing the question"`

**C3** - Submit de Fontes e Bundles captura a rejeição, mostra `.notice.error`, e não limpa a entrada.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "fontes submit shows an error notice without clearing the input"`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "bundles submit shows an error notice without clearing the identifier"`

### S2 - Job da Consulta · App.tsx QueryView · ~16k

**C4** - Job acompanhado é lido por id; ausência na primeira página não mostra «Consulta na fila.»
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows a stored answer when the tracked job is missing from the jobs page"`

**C5** - Job `interrupted` mostra notice em português e não «Consulta na fila.»
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows a Portuguese notice for an interrupted job"`

**C6** - Job `cancelled` mostra notice em português e não «Consulta na fila.»
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows a Portuguese notice for a cancelled job"`

**C7** - Com `answerId` e job `succeeded` ou `answer.json` gravado, o card aparece sem a linha na primeira página.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta shows a stored answer when the tracked job is missing from the jobs page"`

**C8** - Falha do GET da resposta não apaga um card já visível; mostra notice.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta keeps a visible answer when the answer GET fails"`

### S3 - Drop em Fontes · App.tsx SourceView · ~10k

**C9** - Tipo arquivo com `File` escolhido submete com o input de caminho vazio.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "fontes file drop submits without a path"`

**C10** - Tipo arquivo com só caminho (sem ficheiro) continua a submeter.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "fontes file path submits without a dropped file"`

**C11** - URL e repositório mantêm o campo de texto `required`.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "fontes url and repository inputs stay required"`

**C12** - Falha de upload/probe/`queueJob` em Fontes mostra `.notice.error` em português.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "fontes submit shows an error notice without clearing the input"`

## Handoff

S1–S3 = um batch (~44k). Mesmo `App.tsx` e `client.generated.ts`. Sem handoff.

## Swept

- validation: C9, C10, C11
- failure modes: C1, C2, C3, C5, C6, C8, C12
- idempotency: existing - refresh 3s
- authorization: existing - origin loopback
- concurrency: existing - um job acompanhado
- data lifecycle: existing - sessionStorage last-query
- dependency failure: C1, C2, C8, C12
- state transitions: C4, C5, C6, C7
- observability: C1, C2, C3, C5, C8, C12
