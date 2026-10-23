<!-- markdownlint-disable MD034 MD060 -->

# Issue 59 — Revisão mantém preview e acções após a última decisão

Sources:

- https://github.com/oldboydev/sheldon/issues/59 - **binding**: limpar preview e
  botões quando o id sai de `GET /api/v1/reviews`; empty state sem diff anterior;
  sem POST do id decidido a partir do preview velho; teste da última proposta
  aprovada; sem approve por ficheiro / editor / projetos
- `.tasks/issue-59-web-review-stale-preview.md` - critérios 1–4

## Out of scope

- Approve por ficheiro, editor de proposta, revisão de projetos (#41 permanece
  fechada)
- Issues #57, #48; publicar npm 0.2.12
- Mudar GET/POST de review ou a lista pendente no servidor

## Landing

`ReviewView.afterDecide` já refresca a lista e reposiciona `slug`/`proposalId`
quando o id saiu. Esta raia acrescenta `setPreview(undefined)` nesse mesmo ramo,
para o empty state e as acções deixarem de renderizar o documento decidido.

| One-way door | Literal shape                 | Alternative rejected      |
| ------------ | ----------------------------- | ------------------------- |
| None         | estado React em `afterDecide` | n/a — nada aqui é one-way |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Preview após decisão · ReviewView.tsx + review-view.test.tsx · ~28 KB · ~7k

**C1** - Dado um preview aberto, quando Aprovar ou Rejeitar suceder e o id já não
está em `GET /api/v1/reviews`, então `preview` fica vazio e os botões Aprovar e
Rejeitar não aparecem.
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "hides approve and previous wiki body after the last proposal is approved"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "hides approve and previous wiki body after the last proposal is rejected"`

**C2** - Dado que a última pendente foi decidida e `GET /api/v1/reviews` devolve
`topics: []`, então a página mostra «Nenhuma proposta pendente neste vault.» e
não o diff nem o corpo da wiki anterior.
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "hides approve and previous wiki body after the last proposal is approved"`

**C3** - Dado que restam outras pendentes, quando a decisão suceder e o id sair da
lista, então a UI posiciona-se na restante sem mostrar o diff da anterior até
Abrir revisão, e um segundo clique não faz POST do id já decidido a partir do
preview velho.
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "does not post the decided id from a stale preview when another proposal remains"`

**C4** - Sempre, `apps/web/test/review-view.test.tsx` cobre a última proposta
aprovada: sem botão Aprovar e sem o corpo da wiki anterior.
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "hides approve and previous wiki body after the last proposal is approved"`

## Handoff

S1 = um batch (~7k). Mesmo `ReviewView.tsx` e `review-view.test.tsx`. Sem handoff.

## Swept

- validation: existing - Rejeitar exige motivo; Aprovar usa `confirmation` e paths
- failure modes: existing - POST que falha mantém preview e mostra `message`
- idempotency: C1, C3
- authorization: existing - origin loopback
- concurrency: existing - sem lock de clique duplo em voo
- data lifecycle: n/a - só estado React
- dependency failure: existing - GET da lista no `catch` de Aprovar/Rejeitar
- state transitions: C1, C2, C3
- observability: existing - banners de sucesso/rejeição
