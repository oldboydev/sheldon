# Sheldon

Transforme documentos, páginas públicas e repositórios locais em conhecimento que continua útil
depois da tarefa de hoje. Sheldon é um segundo cérebro local-first: preserva as fontes, cria uma
wiki Markdown revisável e permite reutilizar o conhecimento com a CLI, a interface web e agentes
compatíveis.

## Por que Sheldon

Informação importante costuma ficar espalhada entre arquivos, páginas, vídeos e histórico de
projetos. Repetir esse contexto em cada conversa com um agente é lento, difícil de conferir e não
constrói memória durável.

Sheldon separa captura, síntese e aprovação:

1. Você captura uma fonte e conserva o original.
2. A ferramenta normaliza o conteúdo para Markdown e registra a proveniência.
3. Codex CLI, Claude Code ou Grok CLI podem gerar uma proposta de conhecimento.
4. Você revisa e aprova, arquivo a arquivo, antes de a wiki mudar.

O resultado é uma base de conhecimento legível sem Sheldon, rastreável até suas fontes e pronta
para servir de contexto a outros projetos.

## O que ele faz

- Organiza conhecimento em tópicos e projetos, guardando fontes, wiki e resultados no seu disco.
- Importa documentos e dados locais, páginas públicas, crawls pequenos, vídeos públicos do YouTube,
  posts públicos do Instagram e LinkedIn e snapshots de repositórios Git locais.
- Oferece busca local, consultas com referências, revisão de propostas e bundles portáteis de
  conhecimento.
- Expõe conteúdo aprovado para Codex, Claude e Grok por MCP local, com escopo explícito por projeto
  consumidor.
- Inclui uma interface web local para acompanhar o vault e os trabalhos em execução.

## Instalação

O pacote público requer Node.js 24 LTS ou superior e oferece suporte para Windows x64, Linux x64 e
macOS em processadores Intel ou Apple Silicon.

```powershell
npm install --global @oldboydev/sheldon
sheldon --help
```

Para atualizar:

```powershell
npm update --global @oldboydev/sheldon
```

## Comece em minutos

Crie seu vault — a pasta que guarda todo o conhecimento:

```powershell
sheldon init C:\knowledge\sheldon
```

Crie um tópico para reunir conhecimento de um assunto:

```powershell
sheldon topic create "Aprendizado" --vault C:\knowledge\sheldon
```

Abra a interface web local:

```powershell
sheldon web --vault C:\knowledge\sheldon
```

Ela informa uma URL em `http://127.0.0.1:<porta>`. A interface só aceita conexões da própria
máquina.

Confira o ambiente quando necessário:

```powershell
sheldon doctor --vault C:\knowledge\sheldon
```

## Fluxo de trabalho

### 1. Capture uma fonte

Os conectores de fonte são plugins. Confira o que está instalado e o catálogo oficial disponível:

```powershell
sheldon plugin list
sheldon plugin list --remote
```

Quando o conector desejado estiver disponível, instale-o e importe uma fonte. Por exemplo, para um
arquivo local:

```powershell
sheldon plugin install source.file
sheldon ingest file topic aprendizado C:\inbox\artigo.pdf --vault C:\knowledge\sheldon
```

O comando retorna o identificador da fonte e o caminho do conteúdo normalizado. Para uma página
pública, use `sheldon ingest url`; para um crawl limitado, `sheldon ingest crawl`; para um checkout
Git local, `sheldon ingest repository`. Execute `sheldon help ingest` para ver todas as opções.

### 2. Transforme conteúdo em proposta

Depois de capturar a fonte, peça uma proposta a um agente já instalado e autenticado. A proposta
não altera a wiki automaticamente:

```powershell
sheldon compile topic aprendizado proposta-artigo `
  --agent codex `
  --prompt "Extraia ideias práticas e crie notas concisas com fontes." `
  --raw raw/<source-id>/content.md `
  --vault C:\knowledge\sheldon
```

Substitua codex por claude ou grok se preferir. Use `sheldon agent doctor` para diagnosticar a
disponibilidade dos agentes.

### 3. Revise antes de publicar

Veja o que será modificado e aprove somente os arquivos desejados:

```powershell
sheldon review preview topic aprendizado proposta-artigo --vault C:\knowledge\sheldon
sheldon review approve topic aprendizado proposta-artigo wiki/ideias-praticas.md `
  --vault C:\knowledge\sheldon
```

Assim, a wiki só recebe mudanças que você conferiu.

### 4. Encontre e reutilize conhecimento

Busque por texto e filtros locais:

```powershell
sheldon search "prática de recuperação" --topic aprendizado --vault C:\knowledge\sheldon
```

Para levar o conhecimento aprovado a outro projeto, configure o MCP local com um escopo explícito:

```powershell
sheldon mcp configure C:\src\app-consumidor `
  --vault C:\knowledge\sheldon `
  --consumer-id app-consumidor `
  --scope topic:aprendizado
```

O comando mostra uma prévia antes de escrever configurações do cliente, inclusive `.grok/config.toml`
além das configs Codex/Claude. Acrescente `--apply` após revisar essa prévia.

Para instalar o skill Sheldon no consumidor Grok (ou em todos os agentes suportados):

```powershell
sheldon mcp install-skill C:\src\app-consumidor --agent grok --apply
sheldon mcp install-skill C:\src\app-consumidor --agent all --apply
```

`--agent both` continua instalando apenas Codex e Claude; `--agent all` inclui Grok
(`.grok/skills/sheldon`).

## Privacidade e controle

Seu vault é composto por arquivos locais. Fontes originais, conteúdo normalizado, propostas e wiki
permanecem sob seu controle. SQLite é usado apenas para estado operacional e índices
reconstruíveis, não como fonte de verdade do conhecimento.

A interface web usa loopback (`127.0.0.1`) e o MCP usa `stdio`; nenhum deles abre acesso na rede.
Sheldon não chama APIs de modelos diretamente. Codex CLI, Claude Code e Grok CLI são integrações
opcionais e só recebem contexto quando você inicia uma operação que pede um agente.

## Referência e documentação

- Use `sheldon --help` para ver o propósito de cada comando principal e
  `sheldon help <comando>` para consultar subcomandos, opções e a finalidade de cada operação.
- Consulte a [visão do produto](docs/product/vision.md) para princípios e limites.
- Consulte a [arquitetura](docs/product/architecture.md) para contratos, segurança e componentes.
- Consulte o [índice de documentação](docs/README.md) para roadmap, decisões, PRDs e notas de
  implementação.
- Leia o [guia de contribuição](CONTRIBUTING.md) antes de contribuir com o projeto.

## Projeto

Código, issues e contribuições: [github.com/oldboydev/sheldon](https://github.com/oldboydev/sheldon).
