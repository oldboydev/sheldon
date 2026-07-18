# Sheldon — Registro de Decisões Arquiteturais

## ADR-001 — Produto pessoal e local-first

**Decisão:** otimizar o MVP para uma pessoa no Windows, mantendo limites portáveis.

**Razão:** reduz autenticação, permissões e infraestrutura que não contribuem para validar o ciclo de conhecimento.

## ADR-002 — Markdown como fonte de verdade

**Decisão:** raws normalizados, wiki e outputs são arquivos. SQLite é apenas operacional.

**Razão:** arquivos são inspecionáveis, versionáveis, portáteis e independentes do Sheldon.

## ADR-003 — Ingestão determinística por padrão

**Decisão:** plugins capturam e normalizam sem Codex ou Claude.

**Razão:** reduz custo, latência e variabilidade; permite reprocessamento e testes offline.

## ADR-004 — LLM por CLIs autenticados

**Decisão:** Codex CLI e Claude Code são os workers do MVP. O Sheldon não chama APIs de modelos.

**Razão:** reutiliza autenticação existente e satisfaz a restrição de não exigir API paga.

## ADR-005 — Revisão humana antes da wiki

**Decisão:** agentes produzem propostas estruturadas e não escrevem diretamente na wiki aprovada.

**Razão:** evita que um erro de síntese se torne autoridade e contamine compilações futuras.

## ADR-006 — Core em TypeScript

**Decisão:** CLI, API, fila, domínio, MCP e compiladores serão TypeScript sobre Node.js LTS.

**Razão:** favorece streaming de processos, SDK de plugins, compartilhamento de tipos com a interface e distribuição local.

## ADR-007 — Plugins multilíngues por stdio

**Decisão:** plugins usam JSONL sobre stdin/stdout e podem ser implementados em qualquer linguagem.

**Razão:** mantém Docling, Crawl4AI, yt-dlp e ferramentas futuras fora do acoplamento do núcleo.

## ADR-008 — OKF como alvo de compilação

**Decisão:** a wiki interna não é um bundle OKF. Bundles são projeções geradas sob demanda.

**Razão:** aquisição e revisão precisam de estado operacional que não pertence ao formato portátil. Projeções permitem contexto mínimo por projeto.

## ADR-009 — Busca lexical antes de vetores

**Decisão:** o MVP usa FTS/BM25, metadados e grafo de links. Busca vetorial é opcional e local.

**Razão:** entrega busca útil sem modelos de embedding, downloads grandes ou serviços externos.

## ADR-010 — Dependências gratuitas e abertas

**Decisão:** recursos obrigatórios usam somente componentes open source e execução local.

**Razão:** nenhuma função central deve parar porque uma cota, trial ou preço externo mudou.

## ADR-011 — Conventional Commits

**Decisão:** todo commit usa o formato `type(scope): descrição`, conforme Conventional Commits.

**Razão:** histórico legível e semântica consistente facilitam revisão, automação de releases e geração de changelog.

## ADR-012 — Changelog mantido desde o início

**Decisão:** mudanças relevantes são registradas em `CHANGELOG.md`, seguindo Keep a Changelog.

**Razão:** commits descrevem alterações isoladas; o changelog oferece uma visão curada do impacto para usuários e integradores.

## ADR-013 — Gates obrigatórios de lint e verificação

**Decisão:** formatação, lint, typecheck, testes e lints de domínio aplicáveis bloqueiam a conclusão de uma mudança.

**Razão:** plugins multilíngues e artefatos gerados exigem contratos verificáveis, não apenas revisão manual.

## ADR-014 — README acompanha mudanças públicas

**Decisão:** mudanças de comportamento, instalação, comandos, configuração, contratos públicos ou arquitetura atualizam o README correspondente no mesmo commit.

**Razão:** documentação separada do código perde confiabilidade rapidamente e prejudica humanos e agentes consumidores.
