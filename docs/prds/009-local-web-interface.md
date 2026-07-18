# PRD 009 — Interface Web Local

## Problema

A CLI é eficiente para automação, mas não oferece a melhor experiência para acompanhar trabalhos longos, comparar diffs, revisar fontes e explorar conhecimento.

## Objetivo

Entregar uma interface React local que cubra o fluxo principal sem duplicar regras do núcleo.

## Escopo

- Dashboard de saúde e atividade.
- Entrada única para arquivos e URLs.
- Acompanhamento de jobs e diagnósticos.
- Navegação por tópicos, projetos, raws e wiki.
- Revisão de propostas com diff e fontes.
- Busca e consulta.
- Gerenciamento de plugins.
- Definição, preview e build de bundles.

## Fora de escopo

- Hospedagem remota.
- Multiusuário e autenticação web.
- Editor visual completo de Markdown.
- Aplicativo desktop empacotado no MVP.

## Áreas da interface

1. **Início:** saúde, fila, falhas, revisões pendentes e atividade recente.
2. **Fontes:** arrastar arquivo ou colar entrada; preview do plugin e opções antes de executar.
3. **Conhecimento:** árvore, índice, conceito, fontes, links e backlinks.
4. **Revisão:** diff por arquivo, afirmações, contradições, citações e ações.
5. **Consulta:** busca, pergunta, resposta citada e write-back.
6. **Bundles:** definição, seleção, dependências, validação e builds.
7. **Configurações:** CLIs, plugins, caminhos, limites e diagnóstico.

## Requisitos funcionais

1. A UI consome a mesma API local usada pela CLI e não implementa regras de domínio próprias.
2. A entrada mostra qual plugin será usado e se haverá rede, cookies, OCR, STT ou download de modelo.
3. Jobs exibem progresso, etapa, duração, logs úteis, cancelamento e retry.
4. Revisão suporta aprovar tudo, aprovar por arquivo, editar proposta ou rejeitar com motivo.
5. Conceitos mostram proveniência e permitem abrir raws citados.
6. Busca e consulta distinguem resultados locais de execução por agente.
7. Preview de bundle revela conteúdo e avisos antes de gravar build.
8. A interface inicia somente em loopback e escolhe porta livre de forma segura.
9. Recarregar o navegador não perde jobs nem decisões.
10. Todas as ações destrutivas exigem confirmação e mostram o alvo exato.

## Critérios de aceitação

- O usuário conclui arquivo → raw → proposta → aprovação → conceito sem usar CLI.
- Um job longo pode ser acompanhado e cancelado.
- Diff grande permanece navegável por arquivo.
- Falha de plugin mostra ação de recuperação do healthcheck.
- A UI não fica acessível por outra máquina na configuração padrão.
- Um refresh durante execução restaura o estado atual.

## Dependências

- PRDs 001 a 008 para a API e os fluxos expostos.

## Riscos

- Interface virar segundo núcleo de regras.
- Streaming complexo no Windows.
- Diffs e árvores grandes degradarem desempenho.

## Mitigações

- API tipada e cliente gerado.
- Eventos persistidos com retomada por cursor.
- Virtualização e carregamento progressivo.

## Métricas de sucesso

- Taxa de conclusão do fluxo principal sem terminal.
- Tempo até compreender e corrigir uma falha de plugin.
- Latência de navegação em vault de referência.
- Erros de paridade entre CLI e UI.
