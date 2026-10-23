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

O pacote público requer Node.js 24 LTS ou superior. Instale **somente** o metapacote:

```powershell
npm install --global @oldboydev/sheldon
sheldon --help
```

Não instale `@oldboydev/sheldon-win32-x64`, `@oldboydev/sheldon-linux-x64`,
`@oldboydev/sheldon-darwin-x64` ou `@oldboydev/sheldon-darwin-arm64` direto. O npm
escolhe o runtime da máquina (Windows x64, Linux x64, macOS Intel ou Apple Silicon). Fora dessa
matriz a instalação falha com diagnóstico; não há fallback.

A distribuição estável é o dist-tag `latest` (`0.2.0` e posteriores). `@oldboydev/sheldon@0.1.1` no
npm ficou depreciado (protótipo somente Windows x64). Uma versão já publicada instala pelo número:
`npm install --global @oldboydev/sheldon@<versão>`.

Para atualizar:

```powershell
npm update --global @oldboydev/sheldon
```

Para remover:

```powershell
npm uninstall --global @oldboydev/sheldon
```

### Ajuda detalhada (HTML, offline)

```powershell
sheldon help --html
sheldon help --html init
sheldon help --path
```

Abre o guia HTML instalado com a CLI (sem rede), com navegação lateral pelos comandos e
fluxos. `--html` só aceita tópicos do guia (`init`, `ingest`, fluxos, …); `--path` imprime o
diretório e ganha se combinado com `--html`. O `--help` do terminal continua curto.

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
máquina. O chrome segue o design system do produto (navy/magenta, Nunito Sans, wordmark
Sheldon). A seção Conhecimento navega a wiki aprovada em HTML (árvore, página, fontes e
vizinhos) sem editar o vault. Revisão mostra a página wiki proposta (sem o dump de unified
diff) e tira da lista as propostas já aprovadas ou rejeitadas. Depois da
decisão, o preview e os botões Aprovar/Rejeitar saem; com outras pendentes o
diff anterior não fica até Abrir revisão. Uma proposta pendente inválida
(conceito wiki sem frontmatter) mostra `PROPOSAL_INVALID` em vez de um erro genérico; rejeitar
ainda a tira da lista. Consulta pergunta à wiki aprovada, acompanha o job por id (fila, execução, erro,
interrupção) e mostra a resposta citada já gravada mesmo se a linha saiu da primeira
página ou o job foi interrompido. Uma consulta nova descarta GET atrasado da anterior;
falha de transporte no acompanhamento não finge que o job sumiu.
JSON quase válido do agente (headings ATX próximos, conjunto parcial de secções, path
`wiki/` repetido, ou `id`/`truncated` diferentes da tarefa) é canonicalizado antes de
gravar; falha de evidência, de `concepts` ausente ou de validação aparece em português e
a última pergunta volta no formulário. Problemas da API local mostram a `message` no
banner e nos submits. Em Fontes, um arquivo arrastado ou escolhido basta sem preencher
o caminho.

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
sheldon plugin doctor source.file
sheldon ingest file topic aprendizado C:\inbox\artigo.pdf --vault C:\knowledge\sheldon
```

`sheldon plugin doctor <id>` executa o healthcheck do conector. Em `source.youtube` e
`source.instagram`, o probe de `yt-dlp --version` espera até 5 segundos pelo binário empacotado.
Os dois conectores também avisam quando o STT local opcional (`--stt`,
`SHELDON_LOCAL_STT_EXECUTABLE`) não está configurado; nenhum modelo é baixado automaticamente.
`source.youtube` aceita o JSON grande do `yt-dlp` (até 32 MiB). Se o YouTube limitar legendas
(HTTP 429), a ingestão tenta cada língua pedida e devolve `YOUTUBE_RATE_LIMITED` para repetir
depois, ou segue `--stt` quando o runtime local está configurado.

`sheldon ingest` retorna o identificador da fonte e o caminho do conteúdo normalizado. Para uma
página pública, use `sheldon ingest url`; para um crawl limitado, `sheldon ingest crawl`; para um
checkout Git local, `sheldon ingest repository`. Execute `sheldon help ingest` para ver todas as
opções.

No macOS, o catálogo oficial não oferece `source.image`, `source.youtube` nem `source.instagram`.
Esses conectores embarcam executáveis nativos (OCR e yt-dlp) que exigiriam assinatura e
notarização da Apple. `sheldon plugin list --remote` marca-os como `platform unavailable` nessa
plataforma; `plugin install` recusa o ZIP. `source.file`, `source.url`, `source.linkedin` e
`source.repository` instalam nas quatro plataformas. A CLI npm continua cobrindo Windows, Linux e
macOS.

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
disponibilidade dos agentes. O doctor não encaminha o ambiente pai inteiro ao CLI filho — só
PATH, locale, home/temp e a allowlist do perfil.

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

## Licença

Sheldon é distribuído sob a licença MIT. O texto completo está em `LICENSE`.

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

## Governança e agentes

Tracking no [OldBoyDev — Engineering](https://github.com/users/oldboydev/projects/3).
Regras compartilhadas em [AGENTS.md](AGENTS.md); Claude usa [CLAUDE.md](CLAUDE.md)
que importa esse arquivo. Grok lê AGENTS.md nativamente, conforme a
[documentação oficial](https://docs.x.ai/build/features/skills-plugins-marketplaces).
Você pode escolher Grok ou Claude para implementar uma entrega; Codex local revisa.
Isso não muda agentes configurados no produto ou na máquina.

Fluxo: issue → plano/aprovação quando exigidos → implementação e provas →
Codex local → PR → In Review → merge humano. Uma revisão aprovada é suficiente;
o teto de duas tentativas serve somente para correções necessárias.

Comandos novos: `npm run review:run -- --issue N --profile light`,
`npm run review:check -- --issue N --profile light` e `npm run pr:create --
--issue N --profile light --title "tipo: descrição" --body-file caminho.md`.
Perfis light/ui exigem plano e verificação; direct mantém checks aplicáveis sem
esses artefatos. [Guia completo e adoção em outros projetos](scripts/code-review/README.md).
O motor é o mesmo dos pilotos e suas atualizações devem preservar a igualdade dos cinco arquivos.

Relatórios de runtime ficam ignorados em .checks/code-review; histórico/lock ficam
no Git comum, compartilhados entre worktrees. Não publique relatórios depois da
revisão em novo commit: use o resumo gerado no PR. Conteúdo ou contexto alterado
exige revisão válida novamente. Login Codex por ChatGPT; nenhuma IA executa na CI.

O novo workflow de governança roda somente seus testes e sempre publica o check CI.
Documentação tem caminho leve nesse workflow. A CI original de produto continua
rodando como antes, nas três plataformas, inclusive quando seus gatilhos existentes
se aplicam a documentação. Release, publish/npm e OCR permanecem intactos.
Main mantém PR obrigatório, revisão local e merge humano. CI e os três verify são
informativos: falta de minutos do Actions não bloqueia o merge, mas as provas
aplicáveis continuam obrigatórias.

Para uma release autorizada, `npm run release:fallback -- --version X.Y.Z` prefere
preparação na CI e recorre a Windows/Linux local se ela estiver indisponível.
`--publish` aciona a publicação; por padrão apenas prepara. No fallback macOS não
recebe publicação nova; os pacotes e ZIPs anteriores são preservados.
[Requisitos, catálogo e recuperação de falhas](docs/product/release-fallback-runbook.md).
