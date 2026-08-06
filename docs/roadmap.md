# Sheldon — Roadmap

## Estratégia

O roadmap entrega fatias verificáveis. Cada marco termina com software demonstrável e critérios de saída próprios. Datas serão definidas somente quando houver capacidade de execução; a ordem representa dependências técnicas e de produto.

## Marcos

### M0 — Fundação local

**PRD:** 001

**Status:** concluído em 18 de julho de 2026.

Entrega: CLI inicial, vault central, tópicos, projetos, configuração e SQLite operacional.

Saída: criar um vault, reiniciar o processo e reencontrar o mesmo estado sem depender da web.

O marco também estabelece Conventional Commits, `CHANGELOG.md`, READMEs e os comandos unificados de lint, typecheck, testes e verificação.

### M1 — Plataforma de plugins

**PRD:** 002

**Status:** concluído em 18 de julho de 2026.

Entrega: descoberta, protocolo JSONL, execução isolada, healthcheck, timeout, cancelamento e testes de contrato.

Saída: executar um plugin de fixture em Node e outro processo externo com comportamento equivalente.

Evidência: o SDK Node e o fixture PowerShell passam pelo mesmo contrato pós-build; a suíte de aceitação cobre protocolo inválido, stderr, cancelamento e, no Windows, término da árvore do plugin.

### M2 — Primeira memória funcional

**PRDs:** 003, 004 e 005

**Status:** concluído em 20 de julho de 2026.

Entrega: arquivo local vira raw; Codex ou Claude gera proposta; usuário aprova; conceito entra na wiki.

Saída: fluxo completo repetível pelos dois agentes, com fontes e diff de revisão.

Este marco é um checkpoint vertical: utiliza primeiro o caminho de arquivo local do PRD 003. O PRD 003 só é considerado concluído no M3, após as quatro famílias de ingestão passarem por seus critérios de aceitação.

### M3 — Ingestão completa do MVP

**PRD:** 003

**Status:** concluído em 30 de julho de 2026.

Entrega: `source.file`, `source.image`, `source.url`, `source.youtube` e `source.repository` cobrem a fatia atual. A seleção automática direciona imagens ao `source.image`, vídeos únicos ao `source.youtube`, páginas comuns e crawls limitados ao `source.url` e o comando `ingest repository` ao `source.repository`; este último recusa submódulos e checkouts sujeitos a conversão (`autocrlf`, `eol` ou filtros). O crawl exige limites explícitos de páginas e profundidade. Git remoto/autenticado, playlists/canais e STT local para as rotas centrais permanecem fora desta fatia.

Saída: cada família possui fixtures, deduplicação e diagnóstico offline; nenhuma exige API paga.

### M4 — Conhecimento cumulativo

**PRD:** 006

**Status:** concluído em 29 de julho de 2026.

Entrega: busca local, consulta citada, arquivamento de respostas e promoção para nova proposta.

Saída: uma pergunta cruzando conceitos gera resposta rastreável e pode enriquecer a wiki.

### M5 — Conhecimento dentro de projetos

**PRD:** 007

**Status:** concluído em 29 de julho de 2026.

Entrega: MCP local, skill Sheldon e configuração de um projeto consumidor.

Saída: Codex e Claude, dentro de outro repositório, localizam e citam conhecimento relevante sem receber o vault inteiro.

### M6 — Portabilidade OKF

**PRD:** 008

**Status:** concluído em 30 de julho de 2026.

Entrega: definição de seleção, compilador, índice, log, manifesto e validador OKF v0.1.

Saída: bundle reconstruível, conformante e utilizável sem Sheldon.

### M7 — MVP utilizável

**PRD:** 009

**Status:** concluído em 31 de julho de 2026.

Entrega: interface web local para fontes, trabalhos, revisão, wiki, consulta, plugins e bundles.

Saída: o fluxo principal pode ser concluído sem conhecer comandos da CLI.

### M8 — Conectores sociais experimentais

**PRD:** 010

**Status:** concluído em 31 de julho de 2026.

Entrega: framework de plugins autenticados por cookies locais efêmeros e o conector experimental
`source.instagram` para Reels e posts de vídeo públicos. O conector mantém post, metadados,
transcrição disponível e mídia autorizada em raws separados, aplica backoff limitado e fornece
diagnósticos estáveis sem contornar conteúdo privado, DRM, captcha ou anti-bot.

Saída: falhas de plataforma são diagnosticadas claramente e nunca comprometem o núcleo.

### M9 — LinkedIn público experimental

**PRD:** 011

**Status:** concluído em 3 de agosto de 2026.

Entrega: o plugin experimental `source.linkedin` ingere um post individual público ou um LinkedIn
Article público, preservando HTML original, texto normalizado, metadados e imagens explicitamente
autorizadas em raws separados. Uma derivação de OCR opt-in para imagens é orquestrada pelo host
por uma fronteira reutilizável, nunca por chamada informal entre plugins.

Saída: conteúdos públicos de texto e imagem são capturados com limites e diagnósticos estáveis; tela
de login, rate limit, conteúdo privado, documentos e vídeo não produzem bypass nem comprometem o
núcleo.

### M10 — Suporte efetivo a Linux e macOS

**PRD:** 012

**Status:** concluído em 6 de agosto de 2026.

Entrega: Sheldon passa a suportar Windows x64, Linux x64 e macOS Intel/Apple Silicon com diretórios
operacionais conformes à plataforma, isolamento de árvore de processos equivalente, artefatos
verificados e CI nativa para cada sistema.

Saída: criar vault, ingerir fonte, consultar, gerar bundle, instalar plugins oficiais e iniciar a
interface local têm o mesmo contrato operacional e de diagnóstico na matriz publicada.

### M11 — Distribuição pública pelo npm

**PRD:** 013

**Status:** planejado.

Entrega: um único comando instala a CLI pública em Windows x64, Linux x64, macOS Intel e Apple
Silicon, com pacote selecionado pela plataforma, artefatos verificáveis, versão SemVer e publicação
proveniente de uma tag protegida.

Saída: `npm install -g @oldboydev/sheldon` instala a variante suportada, `sheldon --help` e
`sheldon init` funcionam em ambiente limpo, e uma combinação não suportada falha com diagnóstico
acionável sem baixar nem executar artefato aproximado.

## Definição do MVP

No Windows, o usuário consegue:

1. criar tópicos e projetos;
2. ingerir arquivo, site, YouTube ou repositório;
3. preservar raws sem LLM;
4. compilar via Codex ou Claude Code;
5. revisar e aprovar alterações;
6. pesquisar e consultar com citações;
7. usar conhecimento em outro projeto via MCP e skill;
8. gerar e validar um bundle OKF;
9. concluir tudo sem API paga obrigatória.

## Definição de pronto para todos os marcos

Uma entrega só conclui um marco quando:

- lint, formatação, typecheck e testes aplicáveis passam;
- lints de vault, wiki, plugin ou OKF passam quando a entrega toca esses domínios;
- `git diff --check` não encontra erros;
- commits seguem Conventional Commits;
- mudanças relevantes estão no `CHANGELOG.md`;
- README correspondente foi revisado e atualizado junto de mudanças públicas;
- critérios de aceitação do PRD possuem evidência verificável.

## Depois do MVP

- Extensão da ingestão M3: Git remoto/autenticado, playlists e canais do YouTube, STT local para
  as rotas centrais e manutenção versionada dos runtimes OCR.
- Plugins de redes sociais adicionais.
- Busca vetorial local opcional.
- Visualização do grafo.
- Agendamentos e manutenção autônoma revisável.
- Importação de bundles OKF externos.
- Sincronização opcional escolhida pelo usuário.
