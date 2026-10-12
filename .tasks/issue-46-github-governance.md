# Issue 46 — Governança e revisão local

> Implementar com tlc-implement, profile light. Escopo já autorizado nesta conversa.

## Intent

Adotar a governança dos dois pilotos sem duplicar Project ou trocar o implementador.
Preservar os quatro workflows atuais e seus scripts/aliases de qualidade, release e publicação. Um novo workflow governa apenas esta infraestrutura; não substitui os três checks verify.

## Criteria

### Entrega rastreável com revisão local

1. Três IssueForms têm lista de aceite/correção; PR referencia issue/plano/evidências.
2. Project existente, seis status, uma branch/PR, aprovação de Planning e Conventional Commits.
3. Regras compartilhadas permitem Grok ou Claude implementando e Codex local revisando.
4. Cinco arquivos do motor são idênticos à referência; configuração sem overrides herdados.
5. Aprovação encerra revisão; até duas tentativas somente quando correção necessária; falha/stale bloqueiam.
6. Check CI sempre é publicado; novas ferramentas são verificadas, documentação tem caminho leve.
7. Main exige PR e checks strict sem bypass, exclusão/force-push; merge humano.

## Out of scope

- Código de aplicação, credenciais/modelos, agentes globais, IA na CI, merge/deploy/publicação.
- Alterar os workflows atuais do Sheldon ou os aliases de qualidade/release existentes.

## Observable

| Surface  | Decision                                                              | Landing |
| -------- | --------------------------------------------------------------------- | ------- |
| Issue/PR | Problema e aceite na issue; plano e provas versionados; resumo no PR  | 1, 2    |
| Agente   | Grok lê AGENTS; Claude importa o mesmo arquivo; revisor não escreve   | 3       |
| CLI      | Reutilizar contrato e saídas do motor aprovado; erro bloqueia entrega | 4, 5    |
| CI       | Check obrigatório separado, sem IA nem release                        | 6, 7    |

## Swept

- validation: 1, 4, 5.
- failure modes: 5, 6.
- idempotency and retry: 5; Project existente é reutilizado.
- authorization: 2, 7; sem push direto main, exceto bootstrap pendente do skill-me.
- concurrency and ordering: existente no motor aprovado; lock e consulta remota final.
- data lifecycle: existente no motor; histórico no Git comum e runtime ignorado.
- external-dependency failure: 5, 6.
- state transitions: 2; Ready exige aprovação, In Review exige PR, Done exige merge/encerramento.
- observability: 1, 5, 6; evidências no PR e relatório local.

## Impact

Ferramentas e instruções de entrega. Sem alteração de domínio, dados ou API.
Sheldon mantém npm scripts existentes; os testes novos de Node têm runner próprio.

## Decided

Reutilizar o motor integral sem fork; regras locais em AGENTS e configuração.
No Sheldon, CI de governança é adicional; os três checks verify continuam obrigatórios.
Base local: d99fb462bd4d5611f02e34f36ee61b16da8bb3d4. Workflows antigos serão comparados com esse commit.

## Sources

- Conversa: “eu tenho o repo sheldon e skill-me faça as configs de governança neles tbm”.
- Sheldon: “Grok implementa; Codex local revisa antes do PR”; Claude preparado como alternativa.
- Sheldon: “no sheldon tem os CI para deploy e publish isso não pode ser alterado”.
- Issue: [#46](https://github.com/oldboydev/sheldon/issues/46).
- Referência aprovada: ERP dd031d6b1bd9bbd29a8bd2c049f284923af4da45, scripts/code-review/.

## Unresolved

None — escopo e preservação dos pipelines confirmados pelo proprietário.

## Achados da revisão e correções

O Codex local de skill-me encontrou dois defeitos concretos. O filtro adicional de governança foi corrigido para preservar status da operação: exclusão ou renome, mesmo documental, exige validação; edição e adição apenas documentais mantêm caminho leve. Seis testes do filtro/assembly passaram em ambos repositórios. Os workflows anteriores do Sheldon continuam preservados.

Achado no motor herdado: falha de limpeza pode impedir liberação do lock. A proposta isolada libera a trava em finally, preservando relatório/cache/contador e mantendo falhas sem aprovação. Dez testes passaram na proposta, mas ela ainda NÃO foi aplicada ao motor canônico. Aplicação uniforme nos quatro consumidores exige autorização do proprietário para atualizar a referência aprovada. Não resetar contadores/histórico e não fazer fork local.

## Atualização autorizada do motor comum

Proprietário autorizou: “entendi, pode aplicar a correção nos quatro projetos e concluir os PRs, mantendo o deploy e publish do Sheldon intactos”. A referência anterior ERP dd031d6 é atualizada uniformemente com a correção de finalização aprovada: review.mjs/review.test.mjs. CLI/schema/README permanecem iguais. Os cinco blobs continuam idênticos entre todos os consumidores; C2 usa a referência corrigida, sem relaxar paridade. C10 prova lock liberado após limpeza falha, aprovação/cache/contador preservados e falha de revisão sem aprovação. Core configurado mantém limites/histórico; nenhuma exceção adicional. Filtro adicional já corrigido; toda a entrega exige conferência atual antes do PR. A proposta antes pendente está autorizada por esta resposta humana.
