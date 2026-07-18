# PRD 007 — Integração com Agentes: MCP e Skill Sheldon

## Problema

Conhecimento central só ajuda projetos quando agentes conseguem descobri-lo e consumi-lo com contexto mínimo, sem copiar o vault inteiro nem depender de instruções improvisadas.

## Objetivo

Oferecer um servidor MCP local e um skill próprio do Sheldon para Codex e Claude Code.

## Escopo

- Servidor MCP somente local.
- Ferramentas de descoberta, busca, leitura e feedback.
- Skill Sheldon independente do skill usado como referência de pesquisa.
- Configuração de projetos consumidores.
- Escopo por projeto, tópicos e conceitos permitidos.
- Instalação e healthcheck para Codex e Claude.

## Fora de escopo

- MCP acessível pela internet.
- Escrita direta na wiki via MCP.
- Skill `kb` como dependência.
- Configuração automática irreversível dos CLIs.

## Ferramentas MCP do MVP

- `list_scopes`: lista projetos e tópicos autorizados.
- `search_knowledge`: busca conceitos dentro do escopo.
- `read_concept`: lê conceito e metadados de proveniência.
- `read_source_excerpt`: lê trecho de raw explicitamente citado.
- `get_project_context`: retorna índice compacto do projeto.
- `list_related`: retorna links, backlinks e conceitos relacionados.
- `file_feedback`: registra insight, correção ou lacuna como item de entrada, nunca como alteração aprovada.

## Skill Sheldon

O skill contém `SKILL.md`, referências de ingestão, compilação, consulta, revisão e OKF, além de healthcheck. Ele ensina quando buscar conhecimento, como citar conceitos, como reportar lacunas e como evitar tratar a wiki como verdade sem proveniência.

Um único pacote fonte deve gerar instalações compatíveis com Codex e Claude sem duplicar o conteúdo conceitual.

## Requisitos funcionais

1. MCP aceita conexões apenas locais por padrão.
2. Cada chamada aplica o escopo do projeto consumidor.
3. Ferramentas retornam caminhos e identificadores estáveis, além de texto.
4. Leituras de raw exigem referência explícita e registram auditoria.
5. Feedback cria item revisável ligado ao projeto e à sessão de origem.
6. O skill não depende de APIs, SaaS ou do skill `kb`.
7. Instalação mostra todas as alterações de configuração antes de aplicá-las.
8. `sheldon mcp doctor` verifica transporte, ferramentas e escopo.
9. O servidor continua útil sem um bundle OKF previamente gerado.
10. Projetos podem preferir consumir uma definição de bundle quando desejarem contexto congelado.

## Critérios de aceitação

- Codex e Claude descobrem as mesmas ferramentas e recebem resultados semanticamente equivalentes.
- Projeto A não consegue consultar conceito exclusivo do projeto B.
- Um agente encontra conceito relevante sem carregar o vault completo.
- `file_feedback` não modifica wiki nem raw.
- Remover o skill não remove conhecimento nem configuração do vault.
- O pacote funciona sem instalar o skill `kb`.

## Dependências

- PRD 006 para busca e leitura.
- PRD 001 para projetos e configuração.

## Riscos

- Diferenças de descoberta e configuração entre CLIs.
- Exposição excessiva de raws sensíveis.
- Skill ficar desatualizado em relação às ferramentas MCP.

## Mitigações

- Geração a partir de um contrato versionado comum.
- Escopo mínimo e auditoria de raws.
- Teste de compatibilidade do skill e MCP em cada release.

## Métricas de sucesso

- Taxa de chamadas MCP bem-sucedidas por CLI.
- Quantidade média de conceitos lidos por tarefa.
- Violações de escopo detectadas nos testes.
- Feedbacks úteis convertidos em propostas aprovadas.
