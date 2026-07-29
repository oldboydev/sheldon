# Changelog

Todas as mudanças relevantes deste projeto serão registradas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as mensagens de commit seguem [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- Índice local SQLite/FTS5 reconstruível de conceitos aprovados, com busca lexical e filtros de metadados para o M4.
- Consulta M4 index-first por Codex ou Claude, com expansão limitada de links Markdown, citações de wiki/raw, lacunas explícitas e outputs duráveis em `outputs/answers/`.
- Promoção de resposta citada para uma proposta pendente do fluxo de revisão, sem alteração da wiki antes de aprovação explícita.
- Plugin `source.repository` e comando `ingest repository` para publicar snapshots determinísticos de commits de repositórios Git locais limpos, com deduplicação, vínculo de revisão, inventário de seleção e recusa pré-publicação de segredos.
- Catálogo oficial assinado para instalação opcional de plugins e comandos explícitos para gerenciar idiomas do `source.image`.
- Plugins `source.url` e `source.youtube` para captura de uma página pública e de vídeos únicos com legendas; a CLI seleciona automaticamente o vídeo e encaminha `--language` como preferência de legendas.
- Pipeline de release com ZIPs determinísticos por plataforma, catálogo assinado, SBOM, notices e verificação offline antes do upload.
- Matriz nativa de OCR integrada ao release: os quatro artefatos validados são incorporados ao `source.image`; execuções manuais fazem dry run sem upload e somente tags `v*` publicam o catálogo.

### Changed

- Busca e consulta reutilizam o índice local existente por padrão, com `--rebuild` para forçar uma projeção nova; a consulta deixa de materializar o vault inteiro para seguir links e registra truncamento no output da resposta.
- Normalização de corpo Markdown e timestamps ISO estritos foram centralizadas no core para os índices, revisão e respostas persistidas.
- Consultas M4 agora validam o contrato de saída de Codex e Claude de modo consistente, recusam citações fora do contexto e preservam a proveniência real de uma promoção; a resolução de paths também recusa volumes externos no Windows.
- O índice M4 passou a reconstruir transacionalmente depois de validar o vault, usa chaves de caminho por entidade e compara filtros de data por instante normalizado.
- No Windows, o Vitest executa arquivos de teste em série para isolar processos Git, Git Bash e o supervisor nativo; o cleanup de aceitação de plugins também tenta novamente locks transitórios.
- Testes de integração que invocam Git e Git Bash usam limites explícitos de 15 segundos, evitando timeouts espúrios sob carga paralela no Windows sem remover o limite de execução.
- `source.youtube` agora usa o runtime verificado de `yt-dlp` gerenciado pelo próprio plugin. O
  artefato oficial por plataforma contém o executável e seus notices; não há pré-requisito de
  `PATH` nem instalação global pelo usuário.
- A validação de `source.repository` agora exige que os arquivos regulares do checkout sejam byte
  por byte idênticos aos blobs de `HEAD`, sem usar `git status` nem conversões de worktree. Diferenças
  brutas produzidas por `core.autocrlf`, `eol` ou filtros são recusadas, mas uma configuração inativa
  de filtro personalizado não é recusada por si só.
- A validação bruta de `source.repository`, separada do orçamento posterior de seleção, agora limita
  o checkout a 64 MiB agregados e 10.000 entradas de diretório e retorna
  `REPOSITORY_GIT_OUTPUT_LIMIT` quando o orçamento se esgota.
- OCR de imagens passou a ser propriedade exclusiva do `source.image`, com modelos base `por` e `eng` privados ao plugin.

- Verificações locais agora ignoram worktrees e arquivos de scratch aninhados, evitando suites duplicadas e lint de dependências de outra cópia do repositório.
- Ingestão de plugins agora valida caminhos, tipo, tamanho, SHA-256 e limites agregados de artefatos temporários antes de conceder a lease ao consumidor; timeout e cancelamento cooperativo removem a lease e, no Windows, encerram o supervisor dono do Job Object quando necessário.
- Build dos workspaces e transformação TypeScript do Vitest migrados de esbuild para SWC.
- Instalação local de plugins reforçada com validação autoritativa da árvore em staging, leitura estável do manifesto, serialização concorrente do registro e rollback com diagnóstico fiel.
- Lock do registro de plugins reforçado com propriedade por token, recuperação de processos encerrados e liberação que nunca remove propriedade substituta nem mascara o erro primário.
- Publicação de plugins reforçada com verificação da identidade da raiz de staging após o rename e rollback que preserva raízes substituídas por outro proprietário.
- Runner de plugins reforçado com códigos de erro controlados pelo host, captura do exit code após violações de protocolo e decodificação linear da cauda UTF-8 de stderr.
- Após uma violação de protocolo, o host aguarda brevemente o encerramento natural do plugin para registrar o código de saída antes de recorrer ao término forçado.
- A publicação concorrente de raws tolera contenção transitória do Windows ao criar claims exclusivos, sem ocultar falhas de acesso persistentes.
- Verificação pública de contratos de plugins agora também valida o plugin oficial `sheldon.file` após o build.

### Added

- Plugin oficial `sheldon.file` para ingestão offline de PDF, Office, EPUB, HTML, dados estruturados, Markdown, texto e imagens, com seleção automática ou `--plugin`, raws deduplicados e versionados e diagnóstico acionável de OCR local opcional.
- Fluxo vertical M2 de memória: ingestão determinística de arquivo local para raw, compilação de proposta por Codex CLI ou Claude Code, prévia e promoção explícita por arquivo para a wiki.
- Plataforma M1 de plugins: protocolo JSONL v1, validação schema-first, SDK TypeScript para autores, host de instalação/descoberta/execução, comandos `sheldon plugin`, contratos Node SDK e PowerShell, timeout/cancelamento e gate de qualidade de manifestos e contratos.
- Supervisor privado de plugins no Windows com addon N-API, Job Object `KILL_ON_JOB_CLOSE`, falha fechada quando indisponível e término de descendentes mesmo após a saída do processo direto do plugin.
- Inventário de plugins com descoberta de manifestos sem execução, estados de incompatibilidade/colisão, seleção determinística por probe e doctor com persistência da última saúde e remediações.
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
- Estado operacional de plugins para o M1 em `plugin-state.db`, com última saúde reconstruível e os 10.000 resumos de execução sanitizados mais recentes.
- Registro local de plugins com instalação por cópia em staging, publicação e persistência YAML atômicas, rejeição de identificadores duplicados e remoção restrita ao filho registrado exato.
- Execução efêmera de plugins com ambiente allowlist, diretório temporário por operação, framing JSONL limitado, validação terminal e retenção limitada de stderr.
