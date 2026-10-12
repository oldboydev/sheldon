# Code review local — versão 1

Motor reutilizável em Node, Git, GitHub CLI e Codex CLI oficial. Não instala bibliotecas, não exige API key e não executa IA na CI. Codex roda em processo novo, em checkout destacado e sandbox read-only; a revisão examina código/testes/evidências e não executa suítes que escrevem. As verificações do projeto continuam com builder/Verifier/CI.

## Formato da issue

Use exatamente uma seção de critérios com título `Critérios de aceite`, `Critérios de aceitação`, `Acceptance criteria`, `Critérios de correção` ou `Correction criteria`. São aceitos headings Markdown de nível 1 a 6, incluindo o nível 3 gerado pelos Issue Forms do GitHub. Os critérios são itens de lista no nível principal (marcadores ou números; checkboxes são aceitos). A seção termina no próximo heading de nível igual ou superior. Continuações/subitens ficam indentados; evite blocos de código nessa seção. Cada item recebe ID AC1, AC2 etc. O relatório precisa copiar o ID e o texto de **cada** item exatamente uma vez: omissões, duplicatas, extras e textos divergentes são recusados. A issue sem lista clara interrompe o fluxo, sem inferir critérios a partir da implementação. Os comentários complementam o contexto; mudanças de escopo/aceite devem ser incorporadas à seção após aprovação.

## Fluxo do agente

1. Conclua implementação, provas e verificação independente exigidas pelo projeto. Faça commit de tudo; o checkout precisa estar limpo. Vincule aprovação de escopo na issue.
2. Execute `npm run review:run -- --issue N --profile PERFIL`. O motor atualiza a base remota, lê a issue e os comentários, encontra a task e o `.verified.md` quando o perfil exige, e inicia Codex. Havendo mais de uma task/verificação, informe `--task .tasks/issue-N-xxx.md --verification .checks/issue-N-xxx.verified.md`.
3. Leia os achados. Corrija defeitos confirmados dentro do escopo e execute as provas afetadas. Decisão/escopo novo requer o proprietário. Notas seguem o rigor local, sem refatoração cosmética nem enfraquecer testes.
4. Faça commit das correções e repita a revisão, até o limite de rodadas do perfil. Mesma cabeça/base/contexto reutiliza o resultado concluído; novas alterações invalidam. Um limite atingido ou falha interrompe o fluxo; não apague o estado para aparentar aprovação.
5. Com status ready, faça o push autorizado da branch e execute `npm run pr:create -- --issue N --profile PERFIL --title "feat: entrega" --body-file caminho-do-corpo.md`, usando os mesmos argumentos de contexto/base/task/verificação. O comando confere o relatório, a base atual e a cabeça publicada; acrescenta o resumo ao corpo e chama `gh pr create`. Use o template de PR e `Closes #N` ou `Refs #N` no corpo. O Project já configurado move a issue vinculada; merge continua humano.

`npm run review:check -- --issue N --profile PERFIL` apenas confere o resultado; `pr:create` também atualiza a base antes da conferência. Base padrão em `code-review.config.json`, substituível por `--base origin/<branch>` em todos os comandos. Qualquer alteração versionada posterior — inclusive evidência ou regras — requer conferência nova. Não faça commit do relatório de runtime depois da revisão: incorpore o resumo ao PR. `exit 0` do Codex não é aprovação; status, critérios, evidências, achados e identidade são validados.

## Contexto via conector

Se a issue foi lida por um conector autorizado em vez do `gh`, exporte JSON com `number`, `title`, `body`, `url` e `comments` (array de objetos com `body`). Use `--context caminho.json` nos três comandos. A URL deve pertencer à mesma issue/repositório; mudanças no export invalidam a revisão. O agente deve atualizar a exportação antes da entrega, pois o motor não pode detectar mudanças remotas posteriores num arquivo offline. `pr:create` ainda exige GitHub CLI autenticado. Um cliente/conector alternativo pode abrir o PR após `review:check`, conferindo base e cabeça remotas novamente e incluindo o resumo; esta não é uma proteção de servidor contra outros clientes. Após a última leitura de contexto, a abertura consulta base e branch juntas numa chamada git ls-remote e compara ambas com a revisão, imediatamente antes de publicar. As leituras de contexto e referências são preflight, sem transação externa atômica: mudanças posteriores à leitura de cada fonte não podem ser impedidas por este comando e exigem nova revisão no fluxo do agente.

## Relatórios e falhas

Histórico e contador de rodadas ficam no diretório Git comum, `code-review/issue-N.state.json`, compartilhados entre worktrees deste repositório. Saída e cópia legível do estado ficam em `.checks/code-review/issue-N/`, ignorados pelo Git. Se o estado comum ainda não existe, a migração procura históricos legados em todas as worktrees registradas e preserva uma fonte única, mesmo iniciada em outra cópia. Múltiplas fontes interrompem para consolidação pelo proprietário; nenhum histórico vazio é criado nesse caso. Clones independentes têm metadados Git próprios; esta etapa não é uma proteção contra remoção deliberada de metadados. O schema em `schema.json` é o contrato comum: ready, changes_requested ou blocked; critérios met/unmet/unverified; achados P0–P3, cenário, esperado, atual, impacto e localização. P0/P1 e achados blocking impedem entrega. ready exige todos os critérios comprovados e verification sufficient; not_applicable só em perfil sem evidência obrigatória. Ausência de achados não comprova execução de testes.

Erros de auth, contexto, processo, JSON ou mudança da cópia/original não geram ready. Tentativas iniciadas consomem o limite, incluindo falhas técnicas; comunique o bloqueio ao proprietário. O lock e o histórico no Git comum impedem execução simultânea, duplicação e reinício de rodadas da mesma issue entre worktrees. Um resultado concluído com a mesma identidade é reutilizado, inclusive ao retomar um contexto anterior. Se um processo morrer, confira que nenhum revisor está ativo antes de remover manualmente o lock; nunca remova lock/estado de outra entrega. Os checkouts temporários são removidos ao encerrar normalmente.

## Exceção autorizada por entrega

Se o proprietário autorizar rodadas adicionais, registre apenas a issue afetada em `roundOverrides` na configuração versionada, com `profile`, `maxRounds` e `approval` (referência explícita à autorização). Exemplo: `"roundOverrides":{"42":{"profile":"light","maxRounds":3,"approval":"Autorização do proprietário registrada na task da issue 42"}}`. O perfil precisa corresponder ao comando; o novo teto deve superar o padrão e não exceder 10. O histórico anterior permanece na contagem. Outras issues continuam no limite do perfil. O motor valida o registro; o agente deve obter a autorização humana antes de criá-lo, sem assumir que o próprio registro a substitui.

## Adotar em outro projeto

Copie **a pasta inteira** `scripts/code-review/` sem alterar o motor, adicione os aliases abaixo ao gerenciador de tarefas e ignore `.checks/code-review/`. Crie `AGENTS.md` com regras de revisão do projeto e ajuste apenas `code-review.config.json`: versão 1, base remota e profiles, cada um com maxRounds (1–10) e requireEvidence. Exemplo: `{"version":1,"base":"origin/main","profiles":{"light":{"maxRounds":2,"requireEvidence":true},"direct":{"maxRounds":2,"requireEvidence":false}}}`. Projetos sem npm podem chamar `node scripts/code-review/cli.mjs review|check|pr` diretamente.

```json
{
  "review:run": "node scripts/code-review/cli.mjs review",
  "review:check": "node scripts/code-review/cli.mjs check",
  "pr:create": "node scripts/code-review/cli.mjs pr",
  "test:code-review": "node --test scripts/code-review/review.test.mjs"
}
```

Inclua `test:code-review` no teste determinístico existente e instrua o agente a usar a etapa antes de abrir PR. Use Node >=22, Git, `gh auth login` e `codex login` com ChatGPT. O modelo é o configurado no seu Codex; chaves de API do ambiente são removidas deste processo. O motor bloqueia login feito por API key. A máquina precisa permanecer ligada durante a execução; o app desktop pode ficar fechado. Privilégios de shell e credenciais Git seguem os existentes.

O core é vendorizado com arquivos idênticos nos dois consumidores atuais: atualizações devem ser aplicadas juntos e conferidas por hash. Extração para pacote compartilhado fica para quando houver distribuição autorizada; não há registry ou dependência privada nova nesta entrega.
