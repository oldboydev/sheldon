<!-- markdownlint-disable MD029 MD034 MD060 -->

# Issue 59 — Revisão mantém preview e acções após a última decisão

> Build this with **tlc-implement**, profile light.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Em `sheldon web`, depois de Aprovar ou Rejeitar, `afterDecide` refresca
`GET /api/v1/reviews` e muda `slug` / `proposalId` se o id saiu da lista. Não faz
`setPreview(undefined)`. A cópia «Nenhuma proposta pendente neste vault.» só corre
quando `topics.length === 0`. O bloco do preview (wiki, diff, Aprovar / Rejeitar)
está fora desse ramo e depende só de `preview`.

Na última proposta do vault, a lista some e o diff antigo + botões continuam. Um
segundo Aprovar/Rejeitar pode POST de novo. #41 (fechada) omitiu ids decididos da
lista; não limpou o preview aberto. Conferido em `apps/web/src/ReviewView.tsx`
(`afterDecide`, empty state, acções). A issue não dá volume.

Quem usa Revisão vê a wiki e os botões da proposta já decidida e pode POST-ar de
novo o mesmo id, ou o id seguinte com os ficheiros do preview velho.

Depois de Aprovar ou Rejeitar com sucesso, se o id já não está em
`GET /api/v1/reviews`, o preview some e os botões desligam. Com zero pendentes
aparece o empty state. Com outras pendentes a UI posiciona-se na restante sem o
diff anterior até Abrir revisão.

4 criteria in 1 slice · 0 one-way doors · 0 open, of which 0 block

Sizing evidence: CONTRIBUTING does not declare task size; GitHub issue #59 is one
bug; default is one task.

## Criteria

### Preview após decisão

1. Dado um preview aberto, quando Aprovar ou Rejeitar suceder e o id já não está
   em `GET /api/v1/reviews`, então `preview` fica vazio e os botões Aprovar e
   Rejeitar não aparecem.
2. Dado que a última pendente foi decidida e `GET /api/v1/reviews` devolve
   `topics: []`, então a página mostra «Nenhuma proposta pendente neste vault.»
   e não o diff nem o corpo da wiki anterior.
3. Dado que restam outras pendentes, quando a decisão suceder e o id sair da
   lista, então a UI posiciona-se na restante sem mostrar o diff da anterior até
   Abrir revisão, e um segundo clique não faz POST do id já decidido a partir do
   preview velho.
4. Sempre, `apps/web/test/review-view.test.tsx` (ou `app-shell`) cobre a última
   proposta aprovada: sem botão Aprovar e sem o corpo da wiki anterior.

## Out of scope

- Approve por ficheiro, editor de proposta, revisão de projetos — issue #59;
  #41 permanece fechada.
- Contagens do Início / dashboard 12 jobs — issue #57.
- Code-review Windows EPERM TEMP — issue #48.
- Publicar npm 0.2.12.
- Mudar GET/POST de review, `confirmation`, ou a lista pendente no servidor.

## Observable

| Surface                     | Decision                      | Landing                                  |
| --------------------------- | ----------------------------- | ---------------------------------------- |
| screen Revisão              | empty state                   | 2                                        |
| screen Revisão              | preview e acções após decisão | 1, 4                                     |
| screen Revisão              | outras pendentes após decisão | 3                                        |
| screen Revisão              | loading                       | existing - Abrir revisão carrega preview |
| screen Revisão              | error                         | existing - `setMessage` no preview/POST  |
| screen Revisão              | unauthorised                  | n/a - loopback já existente              |
| screen Revisão              | destructive action confirms   | existing - «Confirma a proposta»         |
| API `GET /api/v1/reviews`   | response shape                | existing - sem mudança de contrato       |
| API POST approve/reject     | error shape                   | existing - sem mudança de contrato       |
| document README / CHANGELOG | copy                          | 1, 2                                     |

## Swept

- validation: existing - Rejeitar exige motivo; Aprovar usa `confirmation` e paths
- failure modes: existing - POST que falha mantém preview e mostra `message`
- idempotency and retry: 1, 3 - preview vazio impede POST do id já fora da lista
- authorization: existing - origin/host loopback
- concurrency and ordering: existing - `approve`/`reject` só saem cedo se
  `preview` já é `undefined`; clique duplo em voo antes de `afterDecide` não
  ganha lock nesta raia
- data lifecycle: n/a - só estado React; nada persistido
- external-dependency failure: existing - falha do GET da lista em `afterDecide`
  cai no `catch` de Aprovar/Rejeitar
- state transitions: 1, 2, 3
- observability: existing - banners «Arquivos aprovados…» / «Proposta rejeitada.»

## Impact

| Front       | What changes                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| domain      | existing term: `preview` continua a significar o documento aberto; passa a esvaziar quando o id sai da lista |
| stored data | nothing to migrate                                                                                           |

## Decided

None - limpar `preview` quando o id não está em `GET /api/v1/reviews` é estado
React reversível; o critério 1 já fixa o momento. Não há schema, contrato novo
nem padrão que o código ainda não tenha.

## Sources

- https://github.com/oldboydev/sheldon/issues/59 - comportamento, critérios, fora de escopo
- Conversação 2026-10-23 - «pode fazer a próxima raia em uma nova sessão»; uma
  entrega, um PR, só #59; sem push até o proprietário pedir

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
