<!-- markdownlint-disable MD029 MD034 MD060 -->

# Issue 56 + 58 + 61 — erros da API, job da Consulta e drop em Fontes

> Build this with **tlc-implement**, profile light.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Em `sheldon web`, um JSON de problema da API (`code`, `message`, `recovery`) é lançado
como objeto plano. O refresh só lê `reason.message` em instâncias de `Error`, então o
banner vira «Não foi possível ler o vault local.» Consulta, Fontes e Bundles submetem
sem `catch`: POST 4xx/5xx não muda a tela. A Consulta deriva o job só da primeira
página de `GET /jobs`; job `interrupted`/`cancelled` ou fora da página aparece como
«Consulta na fila.» e um GET da resposta que falha apaga o card. Em Fontes o input de
caminho é `required` mesmo com ficheiro arrastado, então o browser bloqueia o submit.

Quem usa a web vê banner genérico, formulários mudos, Consulta vazia depois de
reinício, e não consegue ingerir PDF por drop no Windows.

A web mostra a `message` real da API, captura falhas de submit, acompanha o job por
id, e aceita drop de arquivo sem caminho.

12 criteria in 3 slices · 1 one-way door · 0 open, of which 0 block

## Criteria

### Erros da API (#56)

1. Dado `GET /api/v1/dashboard` 4xx com JSON `{ message, code }`, quando o App
   refresca, o banner `.notice.error` contém essa `message` e não o fallback
   «Não foi possível ler o vault local.»
2. Dado POST `/api/v1/jobs` não-OK na Consulta, o formulário mostra `.notice.error`
   e a pergunta preenchida permanece.
3. Submit de Fontes e Bundles captura a rejeição, mostra `.notice.error`, e não
   limpa a entrada.

### Job da Consulta (#58)

4. O job acompanhado é lido por `GET /api/v1/jobs/:id`; ausência na primeira página
   de `GET /jobs` não mostra «Consulta na fila.»
5. Job `interrupted` mostra notice em português e não «Consulta na fila.»
6. Job `cancelled` ou `cancelling` mostra notice em português e não «Consulta na fila.»
7. Com `answerId` e job `succeeded` (ou `answer.json` já gravado), a Consulta mostra
   o card mesmo sem a linha na primeira página.
8. Falha do GET da resposta não chama `setAnswer(undefined)` se já há card; mostra
   notice em português.

### Drop em Fontes (#61)

9. Com tipo arquivo e um `File` escolhido/arrastado, o submit segue com o input de
   caminho vazio.
10. Com tipo arquivo e só caminho preenchido (sem ficheiro), o submit continua a
    funcionar.
11. Tipo URL e repositório mantêm o campo de texto `required`.
12. Falha de upload, probe ou `queueJob` em Fontes mostra `.notice.error` em
    português.

## Out of scope

- Compile na web, busca lexical, promote de resposta, cancel/retry de jobs (#56).
- Promote / `sheldon answer`, SSE, Notification (#58).
- `--stt` / OCR / cookies / language na UI; separar Verificar e Iniciar (#61).
- Issues #59, #57, #48.

## Observable

| Surface                     | Decision                | Landing          |
| --------------------------- | ----------------------- | ---------------- |
| screen Início / App banner  | error state             | 1                |
| screen Consulta             | empty / loading / error | 2, 4, 5, 6, 8    |
| screen Consulta             | card da resposta        | 7                |
| screen Fontes               | error / required / drop | 3, 9, 10, 11, 12 |
| screen Bundles              | error no submit         | 3                |
| API `GET /api/v1/jobs/:id`  | already exists          | 4, 7             |
| document README / CHANGELOG | copy                    | 1, 4, 9          |

## Swept

- validation: 9, 10, 11
- failure modes: 1, 2, 3, 5, 6, 8, 12
- idempotency and retry: existing - refresh 3s; GET por id é leitura
- authorization: existing - origin/host loopback
- concurrency and ordering: existing - um job acompanhado; o GET mais recente substitui o estado
- data lifecycle: existing - `sessionStorage` `sheldon-web-last-query`
- external-dependency failure: 1, 2, 8, 12
- state transitions: 4, 5, 6, 7
- observability: 1, 2, 3, 5, 8, 12 - `.notice.error`

## Impact

| Front       | What changes                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain      | existing term: problema da API passa a ser `Error` com `message` (e `code`/`recovery` quando existirem) — `App.refresh`, Consulta, Fontes e Bundles lêem `instanceof Error` |
| stored data | nothing to migrate                                                                                                                                                          |

## Decided

| Decision                                      | Shape                                                                                                                                      | Alternative rejected                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Cliente lança `Error` com a `message` do JSON | `client.request` lê `{ message, code, recovery }` e lança `ApiProblem extends Error`; `instanceof Error` no refresh passa a ver a mensagem | Continuar a lançar o objeto JSON; mapear cada `code` no App |

## Sources

- https://github.com/oldboydev/sheldon/issues/56
- https://github.com/oldboydev/sheldon/issues/58
- https://github.com/oldboydev/sheldon/issues/61
- Conversação 2026-10-23 - uma entrega, um PR fecha as três
- Conversação 2026-10-23 - «pode mais uma rodada da 56» autoriza teto light 3;
  histórico anterior conta (2 rodadas já usadas)

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
