# Sheldon

Segundo cérebro pessoal e local-first que transforma arquivos, sites, vídeos e repositórios em uma wiki Markdown cumulativa, revisável e utilizável por Codex CLI e Claude Code.

## Estado

O planejamento do produto está aprovado e a implementação do marco M0 começou pela fundação do workspace e do vault local.

O marco M0 está implementado: workspace verificável, domínio de entidades, serviço de vault, trilha operacional em SQLite e primeira CLI local. A base cria a estrutura canônica, grava YAML atomicamente, impede colisões, preserva identidade e conteúdo e mantém o banco reconstruível separado do conhecimento.

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

## Desenvolvimento

Pré-requisitos: Node.js 24 LTS ou superior e npm 11 ou superior.

```powershell
npm install
npm run verify
```

Os workspaces ficam em `apps/*` e `packages/*`. O comando `npm run verify` agrega formatação, lint, typecheck, lint de Markdown, testes, cobertura, build, validações de domínio, política documental e `git diff --check`.

O `npm run build` compila os workspaces com SWC para seus diretórios `dist/`. O `npm test` mantém o Vitest como executor e usa SWC para transformar os arquivos TypeScript de teste e de código-fonte.

O `@sheldon/plugin-sdk` é o contrato público schema-first para autoria de plugins. O protocolo v1 usa envelopes JSONL em UTF-8 por stdin/stdout; stdout é exclusivo do protocolo e logs devem ir para stderr.

O `npm run coverage` mede todo o TypeScript em `apps/**/src` e `packages/**/src`, inclusive arquivos não alcançados pelos testes, com o provider V8 local do Vitest. O gate exige no mínimo 80% de statements, functions e lines e 70% de branches. Os relatórios text, JSON e HTML são gerados localmente em `coverage/`; `npm run verify` executa esse gate depois da suíte rápida de testes.

Comandos individuais:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run lint:md`
- `npm test`
- `npm run coverage`
- `npm run lint:domain`
- `npm run lint:repo`

## Uso da CLI

Compile e execute localmente:

```powershell
npm run build
npm run sheldon -- init C:\knowledge\sheldon
npm run sheldon -- doctor --vault C:\knowledge\sheldon
```

Gerencie tópicos e projetos:

```powershell
npm run sheldon -- topic create "Agentes locais" --vault C:\knowledge\sheldon
npm run sheldon -- topic list --vault C:\knowledge\sheldon
npm run sheldon -- topic show agentes-locais --vault C:\knowledge\sheldon
npm run sheldon -- topic rename agentes-locais "Agentes de código" --vault C:\knowledge\sheldon
npm run sheldon -- topic archive agentes-de-codigo --vault C:\knowledge\sheldon
```

Os mesmos subcomandos existem em `project`. Depois de `init`, o caminho fica em `%APPDATA%\Sheldon\config.yaml`, então `--vault` é opcional. Sem um caminho, `init` propõe `%USERPROFILE%\Documents\Sheldon` e exige confirmação ou `--yes`.

Estrutura criada:

```text
vault/
  topics/
  projects/
  bundles/
  system/
    vault.yaml
    operations.db
```

`doctor` não modifica o vault. Se `operations.db` estiver ausente ou corrompido, ele explica como reconstruir o estado operacional sem remover os arquivos de conhecimento.

## Padrões do repositório

- Commits seguem [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): descrição`.
- Toda mudança relevante atualiza o [CHANGELOG](CHANGELOG.md).
- Mudanças de comportamento, instalação, comandos, configuração, arquitetura ou estrutura documental atualizam este README ou o README mais próximo no mesmo commit.
- Lint, formatação, typecheck e testes aplicáveis devem passar antes do commit.
- PRDs e planos não substituem documentação de uso; quando uma entrega se torna executável, seus comandos e exemplos entram no README.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os gates completos.
