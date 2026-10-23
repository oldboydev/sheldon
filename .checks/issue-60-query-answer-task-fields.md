<!-- markdownlint-disable MD034 MD060 -->

# Query answer task fields and partial section salvage

Sources:

- https://github.com/oldboydev/sheldon/issues/60 - eco de id/question/agent/truncated, evidência, Consulta em português
- https://github.com/oldboydev/sheldon/issues/62 - salvage com conjunto parcial de secções
- `.tasks/issue-60-query-answer-task-fields.md` - critérios 1–9

## Out of scope

- Promote / `sheldon answer` - as issues excluem
- Relaxar `assertAnswerEvidence` - as issues excluem
- Alterar prompt ou schema JSON para prosa livre no ecrã - as issues excluem
- Issues #56, #58, #61, #59, #57 e #48 - raias distintas

## Landing

`answerFromAgent` passa a gravar `id` / `question` / `agent` / `truncated` da tarefa e do
`QueryResult`. `ensureAnswerSections` completa secções em falta depois do rewrite da 0.2.10.
`queryJobErrorNotice` traduz falha de evidência. Sem schema/prompt novos.

| One-way door                            | Literal shape                                                                                                                     | Alternative rejected                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Campos da tarefa são do host            | Depois de `status === 'answer'`, os quatro campos vêm da tarefa / `QueryResult`                                                   | Manter os `throw` de eco                                           |
| Salvage parcial insere blocos canónicos | Secção em falta → `## Nome\n- None.` na ordem Wiki facts → Inferences → Gaps; as três em falta continuam a envolver o texto livre | Wrap do texto inteiro em qualquer falta; alargar o regex a sufixos |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Campos da tarefa · query.ts + query-acceptance · ~12k

**C1** - JSON parseável com `text`/`concepts` válidos e `id` diferente do pedido grava
`outputs/answers/<answer-id>/answer.json` com o `id` da tarefa.
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "saves a cited answer when the agent echoes a different id and truncation state"`

**C2** - O mesmo JSON com `truncated` diferente do `QueryResult` persiste o `truncated` do índice.
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "saves a cited answer when the agent echoes a different id and truncation state"`

**C3** - `question` e `agent` persistidos são os da tarefa, não o eco.
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "saves a cited answer when the agent echoes a different id and truncation state"`

### S2 - Salvage de secções parciais · query-answer.ts + agent-runtime + query-acceptance · ~18k

**C4** - Texto com só `## Wiki facts` e citação `wiki/…` grava as três secções canónicas na ordem
Wiki facts → Inferences → Gaps.
Proof: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts -t "canonicalizes a query answer that has only a Wiki facts section"`
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "saves a cited answer that only includes a Wiki facts section"`

**C5** - Heading ATX/bold já coberto pela 0.2.10 continua a gravar com os três `##` canónicos.
Proof: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts -t "rewrites close heading variants into the required ATX section names"`

**C6** - `## Wiki facts` e `## Gaps` sem `## Inferences` persiste `## Inferences` seguido de `- None.` entre as duas.
Proof: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts -t "inserts a canonical Inferences section between Wiki facts and Gaps"`

### S3 - Evidência, JSON ilegível e Consulta · query.ts + App.tsx · ~16k

**C7** - Citação fora do contexto ou omissão de citações do wiki selecionado falha o job sem `answer.json`.
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "rejects an agent answer that cites wiki evidence outside the selected context"`
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "rejects an agent answer that omits citations for the selected wiki context"`

**C8** - JSON ilegível (resposta de agente não parseável) falha o job sem ficheiro.
Proof: `npx vitest run apps/cli/test/query-acceptance.test.ts -t "does not save an answer when the agent returns unreadable query output"`

**C9** - Na Consulta, falha de evidência aparece em `.notice.error` em português, sem `outside its context` nem `omits citations`.
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "consulta translates evidence-outside-context failure into Portuguese"`

## Handoff

S1–S3 = um batch (~46k). Mesmo pipeline de query (CLI → validateQueryAnswer → Consulta). Sem handoff.

## Swept

- validation: C1, C2, C3, C4, C5, C6
- failure modes: C7, C8, C9
- idempotency: existing - `QueryAnswerStore.save` pela mesma chave
- authorization: n/a - vault local
- concurrency: n/a - um job de query
- data lifecycle: C1 - novo `answer.json`; sem migração
- dependency failure: C8
- state transitions: existing - job failed/succeeded
- observability: C9
