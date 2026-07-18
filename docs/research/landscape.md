# Pesquisa — LLM Wiki, Segundo Cérebro e Ferramentas Reutilizáveis

## Objetivo

Esta pesquisa identifica padrões e componentes úteis para o Sheldon. Ela não recomenda copiar integralmente nenhum produto. A arquitetura escolhida preserva Markdown como fonte de verdade, ingestão determinística, revisão humana e agentes executados por CLIs locais.

## Ponto de partida: Karpathy LLM Wiki

[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) propõe uma camada persistente entre fontes brutas e perguntas. Ao ingerir uma fonte, o agente integra o conhecimento a páginas existentes, mantém referências e registra contradições. Consultas úteis podem retornar à wiki e operações ficam em um log cronológico.

### O que adotar

- Raw separado da wiki.
- Conhecimento compilado uma vez e reutilizado.
- Índices para descoberta progressiva.
- Query com write-back.
- Lint estrutural e semântico.
- Markdown e Git como base portátil.

### O que o Sheldon acrescenta

- Ingestão sem LLM por padrão.
- Revisão obrigatória antes de conteúdo autoritativo.
- Plugins isolados e multilíngues.
- Dois agentes substituíveis: Codex CLI e Claude Code.
- Tópicos, projetos e bundles derivados.
- OKF como alvo de compilação.

## Implementações diretamente inspiradas no padrão

### [lucasastorian/llmwiki](https://github.com/lucasastorian/llmwiki)

Pontos fortes:

- MCP como superfície para agentes lerem e escreverem conhecimento.
- Fontes permanecem onde estão e índices são reconstruíveis.
- Uploads de vários formatos, citações, grafo e web clipper.
- Rotina autônoma de manutenção.

Aplicação no Sheldon: adotar MCP, rastreabilidade até fontes e separação entre arquivos e cache. Não adotar escrita autônoma direta na wiki.

### [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)

Pontos fortes:

- Interface desktop com fontes, chat, preview, grafo, lint e revisão.
- `purpose.md` separa objetivo da wiki de seu schema.
- Ingestão em duas etapas: análise antes da geração.
- Hash incremental, fila persistente, retry e watch de diretório.
- Modelo de relevância combinando links, fontes e vizinhança.

Aplicação no Sheldon: adotar propósito por tópico/projeto, fila persistente, hash, revisão e atividade visível. A análise semântica continua na fase de compilação, não na captura.

### [praneybehl/llm-wiki-plugin](https://github.com/praneybehl/llm-wiki-plugin)

Pontos fortes:

- Páginas atômicas com limites explícitos.
- Índices particionados quando a wiki cresce.
- Navegação index-first e busca BM25 como fallback.
- Edições cirúrgicas e ingestão em chunks.
- Lint contra links mortos, órfãos e degradação.

Aplicação no Sheldon: adotar páginas atômicas, índices hierárquicos, busca lexical antes de vetores e limites de escala mensuráveis.

### [yologdev/yopedia](https://github.com/yologdev/yopedia)

Pontos fortes:

- Wiki legível por humanos e agentes.
- Agentes especializados para pesquisa, produto, construção, revisão e arquitetura.
- Operação observável por issues, journal e histórico.

Aplicação no Sheldon: separar responsabilidades em operações e manter trilha de decisões. Multiagentes autônomos não fazem parte do MVP pessoal.

### [Ss1024sS/LLM-wiki](https://github.com/Ss1024sS/LLM-wiki)

Pontos fortes:

- Bootstrap reproduzível e compatibilidade com vários agentes.
- Proveniência, validação e relatórios quantitativos de tamanho.
- Regra clara de write-back e wiki antes de RAG.

Aplicação no Sheldon: adotar scaffolding determinístico, validação e métricas de escala.

## Memória, busca e grafos

### [LLM Wiki v2](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2)

Propõe ciclo de vida, confiança, supersessão, esquecimento, relações tipadas, busca híbrida, automação e governança.

Aplicação no Sheldon: registrar supersessão, status, proveniência e sinais de confiança. Decaimento automático e esquecimento ficam depois do MVP porque podem esconder conhecimento válido.

### [getzep/graphiti](https://github.com/getzep/graphiti)

Pontos fortes:

- Grafo temporal com validade de fatos.
- Episódios como proveniência.
- Recuperação semântica, lexical e por grafo.
- Atualizações incrementais e histórico de supersessão.

Aplicação no Sheldon: inspirar o modelo de versões e proveniência. Não adotar banco de grafo obrigatório no MVP.

### [mem0ai/mem0](https://github.com/mem0ai/mem0)

Pontos fortes:

- Memória por usuário, sessão e agente.
- Recuperação multi-sinal e raciocínio temporal.
- APIs e SDKs simples para consumidores.

Aplicação no Sheldon: diferenciar memória operacional de conhecimento semântico. Não substituir a wiki por memórias opacas.

## Produtos de segundo cérebro e RAG

### [khoj-ai/khoj](https://github.com/khoj-ai/khoj)

Pontos fortes: experiência pessoal em vários dispositivos, agentes configuráveis, automações, pesquisa e suporte a modelos locais.

Aplicação no Sheldon: referência de experiência e automação. O Sheldon permanece focado em compilar wiki, não em ser um assistente geral.

### [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm)

Pontos fortes: instalação local simples, muitos provedores, workspaces, agentes e pipeline de documentos.

Aplicação no Sheldon: referência de onboarding e configuração. Não adotar vector database como fonte de verdade.

### [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx)

Pontos fortes: mais de cinquenta conectores, jobs em background, busca híbrida, agentes, MCP e controles empresariais.

Aplicação no Sheldon: inspirar contratos de conectores, healthcheck e jobs. Escala empresarial e RBAC estão fora do escopo pessoal.

### [infiniflow/ragflow](https://github.com/infiniflow/ragflow)

Pontos fortes: compreensão de documentos complexos, chunking visualizável, citações rastreáveis e pipeline de ingestão configurável.

Aplicação no Sheldon: priorizar qualidade e inspeção da extração. Não adotar sua infraestrutura pesada nem exigir embeddings.

## Componentes de ingestão

### [Docling](https://github.com/docling-project/docling)

Excelente candidato para PDFs, Office, EPUB, áudio, imagens, tabelas, layout e OCR. Deve ser encapsulado por plugin Python e instalado somente quando necessário.

### [MarkItDown](https://github.com/microsoft/markitdown)

Conversor leve para formatos de escritório, áudio, arquivos compactados e YouTube. É um fallback útil quando fidelidade estrutural avançada não é necessária.

### [Crawl4AI](https://github.com/unclecode/crawl4ai)

Produz Markdown orientado a LLM, suporta crawl profundo, páginas JavaScript, sessões e extração de mídia. Deve operar localmente, sem estratégias dependentes de API.

### [yt-dlp](https://github.com/yt-dlp/yt-dlp)

Base para metadados, legendas, playlists e mídia de YouTube e algumas plataformas sociais. Precisa de adapter versionado e diagnósticos porque extratores mudam frequentemente.

### [Repomix](https://github.com/yamadashy/repomix) e [Gitingest](https://github.com/coderamp-labs/gitingest)

Demonstram empacotamento de repositórios, contagem de tokens, respeito a ignores e preparação de contexto. Repomix também destaca compressão por tree-sitter e detecção de segredos.

Aplicação no Sheldon: usar Git e análise estrutural como base; integrar Repomix quando trouxer valor sem tornar seu formato a fonte de verdade.

## Open Knowledge Format

A [especificação OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), publicada pelo Google Cloud, formaliza bundles hierárquicos de conceitos Markdown com YAML. `type` é o único campo obrigatório; `index.md` e `log.md` têm significado reservado; consumidores devem tolerar extensões e conhecimento parcial.

Aplicação no Sheldon: OKF é o formato de distribuição, gerado deterministicamente a partir da wiki aprovada. Raws, propostas e estado operacional não pertencem ao bundle.

## Política de software gratuito

Uma ferramenta só pode ser dependência obrigatória quando:

1. seu código e a funcionalidade usada são open source;
2. sua licença é compatível com a distribuição do Sheldon;
3. funciona localmente sem chave de API;
4. não depende de trial, cota gratuita ou endpoint hospedado;
5. sua instalação, tamanho e acesso à rede são informados antes da execução.

Licenças e dependências transitivas serão verificadas e registradas no PR que introduzir cada componente. Modelos de OCR ou STT são avaliados separadamente da licença da biblioteca.

## Síntese

O melhor caminho não é adaptar uma plataforma RAG completa. É combinar:

- o ciclo cumulativo do LLM Wiki;
- a proveniência e temporalidade de sistemas de memória;
- a disciplina de escala dos plugins de wiki;
- os parsers open source especializados;
- plugins isolados e substituíveis;
- revisão humana;
- OKF como produto compilado para consumo externo.
