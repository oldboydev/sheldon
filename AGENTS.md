# Instruções do sheldon

## Regras próprias do Sheldon

- CONTRIBUTING.md, documentação de produto e contratos existentes continuam vinculantes.
  Preserve README/changelog, os gates de domínio e a disciplina de releases.
- Grok é o implementador atual; Claude pode assumir uma entrega seguindo este mesmo arquivo.
  Isso não troca preferências dos agentes dentro do produto nem configuração global da máquina.
- Examine isolamento/escopo por projeto, origem não confiável, propostas e aprovação do
  conhecimento, permissões/sandbox dos workers, contratos de plugins/OKF, persistência,
  rollback e exposição pelo MCP. Agentes do produto não escrevem conhecimento oficial diretamente.
- Todos os workflows atuais em .github/workflows/ e scripts de release são preservados.
  O workflow de governança é adicional; os três checks verify continuam obrigatórios.
- Testes novos de node:test têm runner próprio; não os execute pelo Vitest. Os testes de
  produto e aliases existentes continuam nos gates originais.

## Governança GitHub

- Issue contém problema, resultado, critérios em lista e aprovações. Plano técnico fica
  em `.tasks/issue-N-<assunto>.md`; evidências em `.checks/`; resumo no PR.
- Use o [Project existente](https://github.com/users/oldboydev/projects/3): Backlog,
  Planning, Ready, In Progress, In Review, Done. Não duplique campos ou Project.
- Planeje mudanças funcionais antes de implementar; aprovação explícita do proprietário
  autoriza escopo e decisões bloqueantes. Pedido explícito para executar escopo já decidido
  vale como autorização. Criação de arquivo não é aprovação.
- Uma branch e um PR por entrega; plano e implementação ficam na mesma branch. Sub-issues
  apenas para entregas independentes e depois de autorização. Não abra PR só para o plano.
- Documentação pura pode usar raia `direct`, com checks aplicáveis e sem task/Verifier.
  Mudança de comportamento usa `light` com task e verificação independente; interface com
  fonte vinculante usa `ui` e compara a fonte. Não rebaixe o rigor para obter aprovação.
- Publique um handoff curto na issue quando Planning exigir decisão; não copie o plano.
- Achados fora do escopo são comunicados e registrados na entrega; não autorizam novas
  issues ou correções. Segurança, perda de dados e quebra de isolamento são comunicadas imediatamente.
- Não faça push direto na main, merge, deploy ou publicação automática. Push de branch/PR
  segue o escopo autorizado; merge e novas decisões continuam com o proprietário.
- Use Conventional Commits: `tipo(escopo): descrição`, com escopo opcional e descrição clara.
- Ready exige aprovação do plano; In Review corresponde ao PR; Done exige merge e encerramento.

## Code Review Rules

- Grok ou Claude implementam, executam as provas e corrigem achados. Codex local é o revisor
  em processo novo, cópia isolada e sandbox somente leitura; ele não implementa correções.
- Ao concluir a entrega, execute automaticamente o fluxo de `scripts/code-review/README.md`,
  sem aguardar novo pedido de revisão: commit limpo, contexto da issue e evidências exigidas,
  `npm run review:run -- --issue N --profile PERFIL`.
- Compare intenção e cada critério da issue com plano, diff e provas; leia CONTRIBUTING e
  regras aplicáveis. Aponte defeito concreto com cenário, esperado, atual, impacto e localização.
- Uma revisão aprovada encerra a etapa. Só correção necessária ou contexto alterado demanda
  nova versão revisada. Mesma identidade reutiliza resultado; não rode para acumular aprovações.
- Perfis light/ui/direct têm teto de duas tentativas, não duas rodadas obrigatórias. light/ui
  exigem task e `.verified.md`; direct dispensa esses artefatos, mas preserva checks aplicáveis.
- Falha, bloqueio, omissão de critério ou contexto desatualizado impede entrega. Trate defeitos
  dentro do escopo e teste a correção. Notas não viram refatoração cosmética ou rodada obrigatória.
- Limite atingido exige decisão do proprietário. Nunca apague histórico nem aumente o teto
  silenciosamente; exceção exige autorização humana específica e registro por issue.
- Não afirme teste que só leu, nem enfraqueça testes para aprovar. O Codex complementa as
  verificações do projeto e do Verifier; processo concluído não significa revisão aprovada.
- Com ready, faça o push autorizado e use `npm run pr:create -- --issue N --profile PERFIL
--title "tipo: descrição" --body-file caminho.md`, incluindo Closes/Refs e evidências.
  Não contorne o comando de entrega. Alteração posterior exige revisão válida para o novo conteúdo.
- O motor não impede outros clientes GitHub nem forma transação atômica com o servidor;
  confira novamente fontes alteradas e mantenha os checks de servidor obrigatórios.
- Core vendorizado: preservar os cinco arquivos comuns e conferir hashes em atualizações.
  Ajuste regras/configuração locais; não crie fork silencioso do motor.

## tlc-implement

profile: light
handoff: on
