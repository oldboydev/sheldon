# Sheldon — Arquitetura do Produto

## Contexto

Sheldon será desenvolvido do zero como um monólito modular em TypeScript. O núcleo oferece CLI, API local, fila de trabalhos, revisão, busca, integração com agentes e compilação OKF. Uma interface React consome a mesma API local.

Bibliotecas especializadas permanecem atrás do protocolo de plugins. Um plugin pode ser escrito em Node.js, Python, Go ou ser um adaptador para um executável local.

## Visão geral

```text
Entrada
  -> Plugin determinístico
  -> Raw imutável + Markdown normalizado
  -> Codex CLI ou Claude Code
  -> Proposta estruturada
  -> Revisão humana
  -> Wiki Markdown aprovada
  -> Busca/MCP e compilação OKF
```

## Estrutura lógica

```text
apps/
  cli/                  Comandos locais
  web/                  Interface React
packages/
  core/                 Casos de uso e regras de domínio
  vault/                Operações atômicas sobre o vault
  persistence/          Estado operacional em SQLite
  plugin-sdk/           Contratos públicos de plugins
  plugin-host/          Descoberta e execução isolada
  agent-runtime/        Adapters Codex e Claude
  review/               Propostas, diffs e decisões
  search/               Busca lexical, metadados e links
  wiki/                 Compilação e validação da wiki
  okf/                  Projeção e validação OKF
  mcp/                  Ferramentas de consumo por agentes
plugins/
  source.file/          Documentos e dados locais offline
  source.image/         Imagens e OCR Tesseract empacotado
  website/              Páginas e sites
  youtube/              Vídeos, canais e playlists
  repository/           Repositórios locais e remotos
```

## Vault central

```text
vault/
  topics/<slug>/        Laboratórios de pesquisa por assunto
  projects/<slug>/      Conhecimento específico de projetos
  bundles/<slug>/       Projeções OKF geradas
  system/               Configuração, cache reconstruível e diagnósticos
```

Cada tópico ou projeto contém raws, wiki, outputs e histórico próprios. Conceitos compartilhados permanecem em tópicos; projetos selecionam conceitos sem alterar o original.

## Limites de confiança

- Plugins não escrevem no vault. Eles recebem uma área temporária e retornam artefatos declarativos.
- Codex e Claude não alteram a wiki oficial. Eles retornam propostas validadas contra JSON Schema.
- O módulo de revisão é o único caminho para promover mudanças semânticas.
- O compilador OKF só lê conteúdo aprovado.
- SQLite não é fonte de verdade do conhecimento. Ele armazena fila, configurações, cache e decisões de revisão.

## Protocolo de plugins

Plugins se comunicam por JSON Lines sobre stdin/stdout. Logs e diagnósticos usam stderr. O contrato mínimo oferece:

- `describe`: identidade, versão, licença e capacidades;
- `probe`: compatibilidade e confiança para uma entrada;
- `ingest`: captura e normalização em `SourceArtifact[]`;
- `healthcheck`: dependências e ações de correção;
- `cancel`: encerramento cooperativo quando suportado.

O host impõe timeout, limite de saída, cancelamento e diretório temporário. Resultados são validados antes de qualquer escrita atômica.

Plugins oficiais são distribuídos opcionalmente por um catálogo de release assinado. A CLI só acessa o catálogo em comandos remotos explícitos ou instalação; listas locais e remoção de idiomas permanecem offline. Artefatos aprovados têm tamanho e SHA-256 validados antes da instalação atômica. O modelo `source.image` mantém seu Tesseract e `tessdata` privados, sem alterar `PATH` ou instalações do sistema.

## Agent runtime

O runtime possui adapters equivalentes para Codex CLI e Claude Code. Cada execução recebe diretórios permitidos, prompt versionado, schema de saída e orçamento operacional configurável. O Sheldon não armazena chaves de modelos e não chama APIs diretamente.

O adapter normaliza eventos dos dois CLIs em estados comuns: iniciado, progresso, proposta produzida, falha, cancelado e concluído.

## Busca

O MVP começa com índice local reconstruível:

- busca lexical BM25 ou FTS5;
- filtros por tópico, projeto, tipo, tag, fonte e data;
- backlinks e links de saída;
- índice de títulos, descrições e aliases.

Busca vetorial não é requisito do MVP. Uma implementação local e gratuita poderá ser adicionada como plugin de busca sem mudar as interfaces de consumo.

## Segurança e privacidade

- Todo dado permanece local, exceto o conteúdo enviado pelos próprios CLIs autenticados do usuário.
- Plugins declaram se acessam rede, executam binários ou leem cookies.
- Ingestão de repositórios verifica segredos antes de preparar contexto.
- Raws preservam origem, hash, plugin e versão do extrator.
- Operações de escrita são atômicas e auditadas.

## Compatibilidade e licenciamento

O núcleo e os plugins oficiais devem usar componentes open source com licenças compatíveis com distribuição. Nenhuma funcionalidade obrigatória pode depender de cota gratuita, período de avaliação ou endpoint pago. Integrações opcionais com serviços externos ficam fora dos plugins oficiais do MVP.

## Gates de qualidade

O workspace terá um comando único de verificação que agrega:

- formatação e lint de TypeScript, JavaScript e JSON;
- typecheck do workspace;
- lint de Markdown;
- testes unitários, de contrato e end-to-end aplicáveis;
- verificação de whitespace do Git;
- lints de domínio para estrutura do vault, wiki, manifests de plugins e bundles OKF.

Nenhuma entrega é concluída com gate obrigatório falhando. Plugins oficiais executam a suíte comum de contrato além de seus testes específicos.

## Disciplina do repositório

- Commits seguem Conventional Commits.
- Mudanças relevantes entram em `CHANGELOG.md` na seção `Unreleased`.
- Mudanças públicas atualizam o README correspondente no mesmo commit.
- Contratos, comandos e exemplos documentados mudam junto do código que os altera.
