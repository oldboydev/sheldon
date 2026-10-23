<!-- markdownlint-disable MD029 MD034 MD060 -->

# Issue 60 + 62 — gravar resposta citada sem eco do agente e com secções parciais

> Build this with **tlc-implement**, profile light.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Hoje um JSON parseável do Grok/Codex/Claude com `text` e `concepts` válidos falha o job
sem `answer.json` quando o modelo ecoa `id`, `question`, `agent` ou `truncated` diferentes
da tarefa. O salvage de headings da 0.2.10 (`ensureAnswerSections`) só envolve o texto
quando faltam as **três** secções; um corpo com só `## Wiki facts` (e citação `wiki/…`)
também falha. Quem usa Consulta perde respostas mais próximas do contrato do que o caso
sem headings nenhum. Evidência: `apps/cli/src/commands/query.ts` (gates de eco) e
`packages/agent-runtime/src/query-answer.ts:169-175` (`missingAll`).

A Consulta/CLI grava a resposta com os campos da tarefa e as três secções canónicas
quando o texto citado é aproveitável; citação inventada ou JSON ilegível continua sem
ficheiro; falha de evidência na Consulta aparece em português.

9 criteria in 3 slices · 2 one-way doors · 0 open, of which 0 block

## Criteria

### Campos da tarefa

1. Dado JSON parseável com `text`/`concepts` válidos e `id` diferente do pedido, quando
   `sheldon query` corre, então existe `outputs/answers/<answer-id>/answer.json` com o
   `id` da tarefa.
2. Dado o mesmo JSON com `truncated` diferente do `QueryResult`, então o ficheiro
   persiste o `truncated` do índice, não o eco.
3. Sempre, `question` e `agent` persistidos são os da tarefa, não o eco.

### Salvage de secções parciais

4. Dado texto com só `## Wiki facts` e uma citação `wiki/…` do contexto, então o
   `answer.json` gravado contém as três secções canónicas na ordem Wiki facts →
   Inferences → Gaps.
5. Dado heading ATX/bold já coberto pela 0.2.10 (`# Wiki facts:`, `**Inferences**`,
   `### Gaps`), então a resposta continua a gravar com `## Wiki facts` / `## Inferences`
   / `## Gaps`.
6. Dado `## Wiki facts` e `## Gaps` com citação `wiki/…` e sem `## Inferences`, então o
   texto persistido inclui o bloco canónico `## Inferences` seguido de `- None.` entre
   as duas secções existentes.

### Evidência, JSON ilegível e Consulta

7. Se o JSON cita evidência fora do contexto selecionado, ou omite citações do contexto
   wiki, o job falha e `answer.json` não é criado.
8. JSON ilegível (não parseável como resposta) continua a falhar o job sem ficheiro.
9. Na Consulta, falha de evidência (`outside its context` ou `omits citations`) aparece
   em `.notice.error` em português, no mesmo padrão das secções Wiki facts, sem o texto
   inglês dessas frases.

## Out of scope

- Promote / `sheldon answer` — as issues excluem write-back para proposta ou wiki.
- Relaxar `assertAnswerEvidence` — citação inventada continua a falhar.
- Alterar o prompt ou o schema JSON para aceitar prosa livre no ecrã — o ecrã mostra o
  texto persistido.
- Issues #56, #58, #61, #59, #57 e #48 — raias distintas; esta entrega não mexe em
  `client.request`, drop de Fontes, Revisão, tiles do Início nem no motor de code-review.

## Observable

| Surface                                  | Decision                              | Landing                              |
| ---------------------------------------- | ------------------------------------- | ------------------------------------ |
| command `sheldon query`                  | output JSON / artefacto `answer.json` | 1, 2, 3, 4, 6                        |
| command `sheldon query`                  | exit / stderr quando falha a meio     | 7, 8                                 |
| command `sheldon query`                  | flags e defaults                      | existing - sem flags novas           |
| screen Consulta                          | empty / loading                       | existing - fila e execução da 0.2.9  |
| screen Consulta                          | error state                           | 9                                    |
| screen Consulta                          | empty state da resposta               | existing - card só com `answer.json` |
| document README / CHANGELOG / `query.md` | copy do comportamento                 | 1–4, 9                               |
| collection `outputs/answers/<id>/`       | naming / overwrite                    | existing - `QueryAnswerStore.save`   |

## Swept

- validation: 1, 2, 3, 4, 5, 6
- failure modes: 7, 8, 9
- idempotency and retry: existing - o mesmo `answer-id` regrava via `QueryAnswerStore.save`; esta entrega não muda a chave
- authorization: n/a - vault local, sem novo principal
- concurrency and ordering: n/a - um job de query de cada vez no executor actual
- data lifecycle: 1 - novo `answer.json`; respostas antigas não são migradas
- external-dependency failure: 8 - stdout de agente ilegível
- state transitions: existing - job `failed` / `succeeded` já existe; esta entrega só muda o que chega a `succeeded`
- observability: 9 - notice da Consulta; stderr do CLI já transporta a mensagem

## Impact

| Front       | What changes                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain      | existing term: `QueryAnswer.id` no JSON passa a ser sempre o `answer-id` da tarefa, alinhado ao path em disco — `QueryAnswerStore`, GET da Consulta e stdout do CLI lêem este campo |
| domain      | existing term: `QueryAnswer.truncated` passa a ser o do `QueryResult`, não o eco — a Consulta já mostra o aviso de índice omitido a partir deste boolean                            |
| stored data | nothing to migrate - só novas gravações; `answer.json` existentes ficam como estão                                                                                                  |

## Decided

| Decision                                       | Shape                                                                                                                                                                                                                                          | Alternative rejected                                                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Campos da tarefa são do host                   | Depois de `execution.status === 'answer'`, `id` / `question` / `agent` / `truncated` vêm da tarefa e do `QueryResult`; o eco do modelo é descartado                                                                                            | Manter os `throw` de eco — Grok não determinístico descarta JSON citado válido                                                                                                       |
| Salvage parcial insere blocos canónicos vazios | Depois do rewrite de headings da 0.2.10, cada secção em falta em `{Wiki facts, Inferences, Gaps}` ganha `## Nome\n- None.` na ordem canónica; quando faltam as três, o texto livre continua a ser o corpo de Wiki facts (comportamento 0.2.10) | Tratar qualquer falta como wrap do texto inteiro (duplicava um heading já exacto); alargar o regex a `## Wiki facts (context)` — a issue pede inserir blocos, não expandir o rewrite |

## Sources

- https://github.com/oldboydev/sheldon/issues/60 - eco de `id`/`question`/`agent`/`truncated`, evidência, Consulta em português
- https://github.com/oldboydev/sheldon/issues/62 - salvage com conjunto parcial de secções
- Conversação 2026-10-23 - uma entrega, um PR fecha as duas; raias web/tooling ficam de fora
- Conversação 2026-10-23 - proprietário: "pode mais uma rodada da 60"; teto light da #60 sobe para 3 em `code-review.config.json`

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
