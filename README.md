# Sheldon

Segundo cérebro pessoal e local-first que transforma arquivos, sites, vídeos e repositórios em uma wiki Markdown cumulativa, revisável e utilizável por Codex CLI e Claude Code.

## Estado

O projeto está na fase de planejamento. A arquitetura, o roadmap e dez PRDs foram aprovados; a implementação ainda não começou.

## Decisões principais

- Core em TypeScript sobre Node.js LTS.
- Ingestores isolados por protocolo de plugins JSONL/stdio.
- Raw e wiki em Markdown; SQLite somente para estado operacional.
- Codex CLI e Claude Code como workers, sem chamadas diretas a APIs de modelos.
- Revisão humana antes de promover mudanças para a wiki.
- OKF v0.1 como formato derivado de distribuição.
- Nenhuma funcionalidade obrigatória dependente de API paga ou SaaS.

## Documentação

- [Índice do planejamento](docs/README.md)
- [Visão do produto](docs/product/vision.md)
- [Arquitetura](docs/product/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Pesquisa comparativa](docs/research/landscape.md)
- [Plano de implementação da fundação](docs/superpowers/plans/2026-07-18-vault-foundation.md)

## Padrões do repositório

- Commits seguem [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): descrição`.
- Toda mudança relevante atualiza o [CHANGELOG](CHANGELOG.md).
- Mudanças de comportamento, instalação, comandos, configuração, arquitetura ou estrutura documental atualizam este README ou o README mais próximo no mesmo commit.
- Lint, formatação, typecheck e testes aplicáveis devem passar antes do commit.
- PRDs e planos não substituem documentação de uso; quando uma entrega se torna executável, seus comandos e exemplos entram no README.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os gates completos.
