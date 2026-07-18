# Changelog

Todas as mudanças relevantes deste projeto serão registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as mensagens de commit seguem [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Changed

- Build dos workspaces e transformação TypeScript do Vitest migrados de esbuild para SWC.

### Added

- Protocol v1 schemas and manifest validation.
- TypeScript plugin runner with cooperative cancellation.
- Visão, arquitetura, modelo de conhecimento e decisões do produto.
- Roadmap do MVP e pós-MVP.
- Dez PRDs cobrindo fundação, plugins, ingestão, agentes, wiki, busca, MCP, OKF, interface e redes sociais.
- Pesquisa comparativa de projetos LLM Wiki, memória, RAG e ferramentas de ingestão.
- Política de commits semânticos, changelog, lint e atualização coordenada de READMEs.
- Plano TDD detalhado para a implementação da fundação e do vault central.
- Workspace npm/TypeScript inicial com formatação, lint, typecheck, testes, lint de Markdown, Commitlint e validação de domínio.
- Baseline em Node.js 24 LTS usando o SQLite nativo do runtime para evitar dependências binárias externas.
- Contratos de tópicos e projetos com identidade estável, slugs normalizados, renomeação e arquivamento.
- Serviço de vault com descoberta explícita, layout canônico, metadados YAML, escrita atômica e proteção contra colisões.
- Trilha operacional reconstruível em `node:sqlite` para criação, renomeação e arquivamento de entidades.
- CLI local para inicialização, diagnóstico e ciclo de vida de tópicos e projetos, com configuração separada em `%APPDATA%`.
- Bundle executável da CLI com preservação explícita dos módulos nativos `node:*`.
- Testes de aceitação do PRD 001, incluindo falha atômica injetada, descoberta por configuração e recuperação após remoção do SQLite.
- Lint de repositório que exige `README.md` e `CHANGELOG.md` junto de mudanças de implementação.
- Gate local de cobertura Vitest/V8 para `apps/**/src` e `packages/**/src`, com relatórios text, JSON e HTML e mínimos de 80% para statements, functions e lines e 70% para branches.
