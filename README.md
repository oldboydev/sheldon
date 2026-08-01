# Sheldon

Segundo cérebro pessoal e local-first que transforma arquivos, sites, vídeos e repositórios em uma wiki Markdown cumulativa, revisável e utilizável por Codex CLI e Claude Code.

## Estado

O planejamento do produto está aprovado e a implementação do marco M0 começou pela fundação do workspace e do vault local.

Os marcos M0 e M1 estão implementados. M0 entrega o workspace, o domínio de entidades, o vault e a CLI local; M1 entrega a plataforma de plugins. O `@sheldon/plugin-sdk` é o contrato público para autores e o `@sheldon/plugin-host` instala, descobre, executa e diagnostica plugins sem misturar o estado operacional ao conhecimento. No M3, `source.file`, URL pública única e crawl público limitado por `ingest crawl`, YouTube público de vídeo único com legendas e snapshots de commits Git locais já estão disponíveis. `source.image`, OCR e seu runtime nativo existem na implementação; estão pausados somente o trabalho de release e a manutenção do runtime nativo, fora do escopo atual de conectores. Git remoto/autenticado, playlists/canais e STT local continuam adiados.

O builder Windows do runtime OCR executa ferramentas filhas em um Job Object com limite por
etapa; quando expira, encerra a árvore e retorna o diagnóstico de timeout sem depender do cleanup
dos pipes redirecionados. A limpeza também evita dispor stdin sincronicamente quando uma escrita
de fundo está bloqueada em um pipe cheio.

O M2 adiciona o primeiro fluxo vertical de memória: um arquivo local é preservado como raw, Codex CLI ou Claude Code gera uma proposta estruturada, e somente arquivos da wiki escolhidos explicitamente na revisão são promovidos.

O M8 acrescenta o plugin experimental `source.instagram` para Reels e posts de vídeo públicos.
Ele nunca tenta contornar conteúdo privado, DRM, captcha ou anti-bot. O pacote oficial contém seu
próprio runtime verificado de `yt-dlp`; `plugin doctor` sinaliza uma instalação incompleta. Cookies
locais são opcionais e enviados somente ao processo isolado (nunca ao vault, raw, manifesto ou
log); use
`ingest url ... --plugin source.instagram --cookies C:\cookies.txt` quando uma sessão local for
necessária. A captura preserva texto, metadados, transcrição disponível e mídia explicitamente
autorizada como raws separados. `--stt` só aceita uma runtime local já configurada: o plugin não
baixa modelos nem inventa fala ausente. Configure `SHELDON_LOCAL_STT_EXECUTABLE` e, se preciso,
`SHELDON_LOCAL_STT_ARGUMENTS` como um array JSON que contenha no máximo um placeholder `{input}`;
o comando deve escrever a transcrição em stdout.
Se o extrator declarar uma legenda que não materializou, a captura permanece válida como uma
lacuna; caminhos fora do diretório temporário ou links simbólicos continuam bloqueados. As opções
`--media` e `--stt` são aceitas por qualquer plugin que declare, respectivamente, permissão de
mídia e efeito de STT local.
Quando STT local é necessário, a entrada temporária é limitada a 50 MiB; um download que não cabe
nesse orçamento é diagnosticado como limite de mídia, e o raw registra por que uma legenda foi
descartada sem inventar transcrição.

O M4 entrega busca local e consultas citáveis: conceitos aprovados são projetados em SQLite/FTS5 para busca lexical e filtros de metadados; consultas por Codex ou Claude começam pelo índice, registram evidências e só promovem uma síntese como proposta pendente para revisão. O M5 entrega MCP local por `stdio`, escopos explícitos por projeto consumidor, auditoria de leitura de raw, feedback revisável e um skill Sheldon gerado de uma única fonte para Codex e Claude. O M6 acrescenta bundles OKF v0.1: projeções locais, portáteis, determinísticas e reconstruíveis de conceitos aprovados.

## Interface Web Local (M7)

Depois de inicializar ou selecionar um vault, abra a bancada local com:

```powershell
npm run build
npm run sheldon -- web --vault C:\knowledge\sheldon
```

O comando informa uma URL em `http://127.0.0.1:<porta>` e escolhe uma porta livre quando `--port` não é informado. A interface nunca escuta em rede: além do bind em loopback, ela rejeita `Host` e `Origin` externos. Ela reúne o estado do vault, fontes, jobs, conhecimento e diagnósticos sem alterar as regras de domínio existentes. Os trabalhos ficam no SQLite operacional e o navegador pode ser recarregado durante a execução: a tela retoma os eventos pelo cursor persistido. Um cancelamento propaga para plugins e agentes e interrompe a publicação antes que raws, propostas ou builds sejam materializados.

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
- [Design da plataforma de plugins](docs/superpowers/specs/2026-07-18-plugin-platform-design.md)
- [Plano de implementação da plataforma de plugins](docs/superpowers/plans/2026-07-18-plugin-platform.md)

## Desenvolvimento

Pré-requisitos: Node.js 24 LTS ou superior e npm 11 ou superior.

```powershell
npm install
npm run verify
```

Os workspaces ficam em `apps/*` e `packages/*`. O comando `npm run verify` agrega formatação, lint, typecheck, lint de Markdown, testes, cobertura, build, validações de domínio, política documental e `git diff --check`. Worktrees locais e scratch de automação são excluídos da descoberta de Markdown e testes, portanto não duplicam suites nem validam dependências de outra cópia do repositório.

O workspace `@sheldon/search` oferece `SearchIndex.rebuild(vaultRoot)`, que valida `wiki/` antes de substituir transacionalmente `system/search-index.db`. Esse banco é cache reconstruível, não é a fonte de verdade e pode ser removido quando necessário; `SearchIndex.open(vaultRoot)` falha com diagnóstico explícito se ele ainda não foi construído.

Pull requests e commits para `main` executam `npm run verify` na CI Windows (`windows-2022`), a plataforma suportada pelo MVP e pelos testes de isolamento de processo. O mesmo gate local cobre formatação, lint, typecheck, testes, cobertura, build, contratos de plugin, validações de domínio/repositório e o check de diff.

A reconstrução dessa projeção é uma operação de processo único: não execute comandos com `--rebuild` concorrentemente sobre o mesmo vault. Se houver contenção, aguarde o outro comando terminar e tente novamente; Sheldon não substitui um erro de lock por uma reconstrução automática.

## Busca, consultas e write-back (M4)

`search` é sempre lexical e local: não inicia Codex nem Claude. Ele abre a projeção descartável existente, reconstruindo-a só quando ausente ou quando `--rebuild` é solicitado, e imprime resultados JSON com score, snippet, origem do match e relações diretas entre conceitos da mesma entidade. Essas relações são links Markdown locais e seus backlinks — não similaridade semântica. Os filtros de tópico, projeto, tipo, tag, status e data reduzem somente os resultados lexicais raiz; não escondem vizinhos já ligados a um resultado. Para manter a saída previsível, cada resultado da CLI projeta e serializa no máximo 100 relações, em ordem determinística, e declara `relatedConceptsTruncated: true` quando houver mais. Esse limite não reduz as relações indexadas durante a reconstrução nem a travessia independente de relações feita por `query`.

Links escritos em blocos cercados, código inline ou comentários HTML não formam relações. Blocos Markdown somente indentados continuam sendo tratados como prosa para a projeção: essa escolha evita ocultar relações em continuações de listas, embora um exemplo de código indentado possa aparecer como relação local.

```powershell
npm run sheldon -- search "retrieval practice" --topic memory --vault C:\knowledge\sheldon
```

Para uma síntese, `query` restringe a seleção a uma entidade, abre o mesmo índice local (ou o reconstrói com `--rebuild`), começa pelos resultados lexicais e pode seguir links Markdown locais e backlinks até dois saltos (`--link-depth`, padrão 1). Os filtros selecionam somente as raízes lexicais; a expansão preserva os vínculos diretos delas mesmo que o vizinho tenha metadados diferentes. Os registros de conceito selecionados (path, título e corpo) são limitados deterministicamente a 24.000 caracteres por padrão (`--max-context-chars`), e qualquer corte fica marcado na resposta. O agente recebe somente esse contexto citado; a resposta persistida distingue fatos da wiki, inferências e lacunas. Sem cobertura indexada, Sheldon salva uma lacuna explícita com sugestão de fonte e não chama o agente.

Se uma cobertura indexada existir, mas seu path e título não couberem no orçamento, Sheldon também não chama o agente: a resposta registra que a cobertura foi excluída pelo limite, em vez de reportar incorretamente ausência de cobertura.

```powershell
npm run sheldon -- query topic memory retrieval-answer-001 `
  --question "Como prática de recuperação e espaçamento se relacionam?" `
  --agent codex `
  --link-depth 1 `
  --max-context-chars 24000 `
  --vault C:\knowledge\sheldon
```

Cada resposta fica em `outputs/answers/<answer-id>/answer.json` dentro da entidade e registra pergunta, agente, conceitos e raws citados, timestamp, se a seleção foi truncada e texto final. O comando não altera `wiki/`.

Uma resposta com raws citados pode gerar uma proposta pendente. A proposta continua no fluxo normal do PRD 004: confira a prévia e aprove arquivos individualmente antes que qualquer wiki seja modificada.

```powershell
npm run sheldon -- answer promote topic memory retrieval-answer-001 proposal-001 `
  --prompt "Proponha uma nota durável a partir da resposta citada." `
  --vault C:\knowledge\sheldon
npm run sheldon -- review preview topic memory proposal-001 --vault C:\knowledge\sheldon
npm run sheldon -- review approve topic memory proposal-001 wiki/retrieval.md --vault C:\knowledge\sheldon
```

O `npm run build` compila os workspaces com SWC para seus diretórios `dist/`. No Windows, a compilação a partir do código-fonte também usa `node-gyp` e exige Python 3, Visual Studio 2022 com a carga de trabalho **Desenvolvimento para desktop com C++** e um Windows SDK compatível. O build seleciona VS 2022 automaticamente quando o ambiente não informa outro toolchain compatível. O artefato de distribuição para Windows inclui o addon privado `native/windows-job/build/Release/sheldon_job_object.node`; quem usa esse artefato não precisa recompilar o addon. O `npm test` mantém o Vitest como executor e usa SWC para transformar os arquivos TypeScript de teste e de código-fonte.

Testes de integração que criam processos Git ou Git Bash definem um limite finito específico quando o seu trabalho legítimo excede o padrão do Vitest sob carga concorrente; isso preserva tanto o timeout quanto as verificações de falha fechada. No Windows, os arquivos de teste também são serializados para isolar Git, Git Bash e o supervisor nativo enquanto usam os diretórios temporários do sistema.

`npm run verify:plugin-contract` executa os contratos pós-build dos fixtures Node SDK e PowerShell, além do plugin oficial `source.file`; `npm run verify` já o inclui antes do lint de domínio.

## MCP local e skill Sheldon (M5)

O MCP de Sheldon é exclusivamente local: Codex e Claude o iniciam por `stdio`; ele não abre porta, não chama API nem envia o vault para um serviço. Cada projeto consumidor declara um ID estável e os únicos tópicos ou projetos que pode consultar em `.sheldon/mcp.yaml`. Sem esse arquivo, um escopo não vazio e um índice local existente, o servidor falha fechado.

Primeiro crie a prévia. Ela lista integralmente o arquivo de escopo e as entradas de descoberta dos dois clientes, sem escrever nada. Passe `--apply` somente depois de conferi-la:

```powershell
npm run sheldon -- mcp configure C:\src\app-consumidor `
  --vault C:\knowledge\sheldon `
  --consumer-id app-consumidor-01 `
  --scope project:app-conhecimento `
  --scope topic:arquitetura
npm run sheldon -- mcp configure C:\src\app-consumidor `
  --vault C:\knowledge\sheldon `
  --consumer-id app-consumidor-01 `
  --scope project:app-conhecimento `
  --scope topic:arquitetura `
  --apply
```

O comando não substitui uma configuração de cliente já existente. Ele cria `.codex/config.toml` e `.mcp.json` no projeto consumidor, ambos apontando para `sheldon mcp serve --consumer-config ...`. Instale o mesmo skill canônico para um ou ambos os clientes, também com prévia antes da cópia:

```powershell
npm run sheldon -- mcp install-skill C:\src\app-consumidor
npm run sheldon -- mcp install-skill C:\src\app-consumidor --apply
npm run sheldon -- mcp doctor --consumer C:\src\app-consumidor
```

O skill ensina a buscar e citar IDs, paths e proveniência; não depende de `kb`, SaaS ou APIs. As sete ferramentas são `list_scopes`, `search_knowledge`, `read_concept`, `read_source_excerpt`, `get_project_context`, `list_related` e `file_feedback`. `search_knowledge` retorna no máximo 20 resultados por padrão, mantendo a ordem local BM25 (score menor é mais relevante). `read_concept` devolve o corpo da wiki aprovada, limitado a 12.000 caracteres por padrão e marcado quando truncado. `read_source_excerpt` exige que o conceito cite explicitamente o raw e registra o acesso em `system/mcp-raw-audit.jsonl`, sem armazenar o trecho na auditoria. `file_feedback` exige um escopo autorizado e cria um JSON pendente em `outputs/feedback/` da entidade, vinculado ao projeto consumidor e à sessão; nunca altera `wiki/` nem `raw/`.

Quando houver um descritor de escopo local, `--bundle <arquivo>` o referencia relativamente a `bundles/`. O servidor só aceita um descritor que reduza os escopos já autorizados; um arquivo ausente, fora de `bundles/` ou que amplie o acesso é recusado. Assim, um projeto pode preferir a seleção congelada sem criar uma rota alternativa para o vault inteiro.

Esse descritor pertence somente ao MCP e não é a definição de compilação OKF do M6:

```yaml
# bundles/contexto-congelado.yaml
scopes:
  - kind: project
    slug: app-conhecimento
```

Cada item deve já constar dos escopos do consumidor; o bundle só pode estreitar a seleção.

## Bundles OKF portáteis (M6)

Um bundle OKF é uma projeção descartável e copiável da wiki aprovada. Ele seleciona conceitos pelo
`concept_id` estável, nunca pelo caminho mutável da wiki, e grava sua definição em
`bundles/<bundle-id>/definition.yaml`. A definição declara a finalidade do bundle, os conceitos
explícitos e as políticas de dependência e de links para conceitos não selecionados. Use `bundle
create` para criar uma definição versionável:

```powershell
npm run sheldon -- bundle create app-contexto `
  --concept arquitetura-local `
  --concept convencoes-api `
  --title "Contexto para a aplicação" `
  --description "Conhecimento aprovado necessário para a manutenção local." `
  --dependencies recursive `
  --max-depth 2 `
  --unresolved-link include `
  --vault C:\knowledge\sheldon
```

Na CLI, as dependências podem ser `explicit` (somente os IDs indicados), `direct` (um salto de
links) ou `recursive` (até `--max-depth`). No arquivo, os mesmos valores são respectivamente
`none`, `direct` e `recursive`. Para um link cujo alvo não faça parte da seleção, a política da CLI
é `include`, `keep-broken` ou `remove-warning`; no YAML ela é `include`, `keep` ou `remove`.
`include` reescreve os links dos conceitos já alcançados, mas nunca amplia a seleção além da
política de dependências: com `explicit`, somente os IDs indicados entram; com `recursive`,
`max_depth` também limita o fechamento de links. Um alvo cortado por esse limite permanece como
link quebrado com diagnóstico explícito para revisão no preview.
Revise e versione `definition.yaml` como qualquer outra configuração do projeto; a seleção
permanece estável se páginas da wiki forem renomeadas.
O arquivo criado usa este formato canônico:

```yaml
version: 1
bundle_id: app-contexto
concept_ids:
  - arquitetura-local
  - convencoes-api
dependencies:
  mode: recursive
  max_depth: 2
unresolved_links: include
```

Faça primeiro a prévia da seleção, incluindo os `tags` declarados por conceito e
`sensitivity.level: unspecified` enquanto o vault não declara uma taxonomia de sensibilidade. A
prévia nunca escreve o bundle; use `--apply` somente depois de revisar os conceitos, diagnósticos e
sinais reportados. O modo `strict` bloqueia conceito ausente, arquivado ou não aprovado e falhas de
conformidade; `lenient` preserva diagnósticos que não impedem o artefato, como um tipo local
desconhecido. A política OKF v0.1 atual reconhece `note`: em `strict`, outro tipo é um erro; em
`lenient`, é um aviso explícito. Um link mantido deliberadamente por `keep-broken` também é
reportado como aviso sem invalidar o bundle gerado.

```powershell
npm run sheldon -- bundle build app-contexto --mode strict --vault C:\knowledge\sheldon
npm run sheldon -- bundle build app-contexto --mode strict --apply --vault C:\knowledge\sheldon
npm run sheldon -- bundle validate C:\knowledge\sheldon\bundles\app-contexto\build --mode strict
```

O diretório `build/` contém somente Markdown UTF-8 com frontmatter OKF v0.1, links relativos
portáteis, índices `index.md` para descoberta progressiva, `log.md` e um manifesto de build com a
definição, conceitos, hashes e proveniência no vault. O log registra a data determinística da última
mudança a partir do timestamp dos conceitos-fonte e preserva esse resumo em rebuilds idênticos. Não
é necessário manter Sheldon instalado para ler uma cópia desse diretório. Compare duas projeções
com saída determinística antes de distribuí-las:

```powershell
npm run sheldon -- bundle diff C:\releases\app-contexto-anterior C:\knowledge\sheldon\bundles\app-contexto\build
```

`bundle validate` confere os hashes dos arquivos declarados no manifesto antes de aceitar a cópia.
As exceções `keep-broken` continuam sendo política local declarada pelo próprio manifesto; sem
assinatura ou trust store (fora do escopo do M6), a validação estrita verifica conformidade e
integridade acidental do payload, não autenticidade de um autor externo.

O compilador lê exclusivamente conceitos já aprovados; nunca usa OKF como raw ou wiki interna. A
operação é local e não acessa a rede, não importa bundles externos e não publica o artefato. Um
novo build com a mesma definição e a mesma wiki aprovada produz conteúdo idêntico.

O `@sheldon/plugin-sdk` é o contrato público schema-first para autoria de plugins. O protocolo v1 usa envelopes JSONL em UTF-8 por stdin/stdout; stdout é exclusivo do protocolo e logs devem ir para stderr.

## Plugins oficiais e OCR

Os plugins instalados são administrados pelo registro local. Quando um catálogo oficial remoto assinado estiver publicado e acessível, a CLI poderá consultá-lo: `plugin list --remote` e `plugin info <id> --remote` o carregam sem instalar nada; `plugin install <id>` poderá baixar e instalar um artefato oficial disponível após validar a assinatura do catálogo, a plataforma, o tamanho e o SHA-256. Se esse catálogo disponibilizar artefatos de idioma, `image language install <code>` poderá instalar um deles para o `source.image` já instalado.

`source.file` processa documentos e dados locais. Ele não reivindica imagens e não executa OCR. A ingestão de imagens pertence a `source.image`; sua implementação e o runtime nativo de OCR existem. Quando artefatos de idioma assinados forem publicados no catálogo, idiomas adicionais poderão ser administrados por ele. A manutenção e a publicação de novos releases desse runtime estão pausadas e não fazem parte do escopo atual de conectores.

O instalador oficial baixa o artefato para uma área privada de staging, valida o manifesto e a árvore extraída e publica a instalação em `%APPDATA%\Sheldon\plugins\<id>` antes de persistir o registro YAML atômico. Identificadores já instalados são rejeitados, sem opção de sobrescrita.

A instalação oficial usa a rede somente por solicitação explícita para baixar o catálogo e o artefato verificados; ela não executa código ou scripts de pacote, nem instala dependências. Instalações e remoções concorrentes são serializadas por processo e por um lock exclusivo no diretório da aplicação para impedir perda de registros. O lock registra token de propriedade, PID e horário, preserva locks de processos ativos e recupera com segurança locks abandonados por processos encerrados. A remoção aceita somente um identificador registrado e apaga apenas o filho exato correspondente dentro do diretório de plugins, respeitando a comparação de caminhos sem distinção entre maiúsculas e minúsculas no Windows.

Cada operação `describe`, `probe` ou `healthcheck` inicia um processo novo com `shell: false`, diretório de trabalho na raiz do plugin e um ambiente sanitizado. Somente `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR` e variáveis de locale são encaminhadas; `TEMP` e `TMP` apontam para um diretório exclusivo da operação. Entradas e ambiente não são copiados para o histórico operacional.

Quando o host detecta uma violação do protocolo JSONL, ele dá uma breve oportunidade para o processo já em encerramento finalizar naturalmente e registrar seu código de saída; se continuar ativo, o término forçado permanece obrigatório.

O contrato de limites do host publica 10 segundos para `describe` e `probe`, 30 segundos para `healthcheck` e 15 minutos para `ingest`, destinados ao controlador de ciclo de vida. Os limites já aplicados pelo runner restringem cada linha JSONL a 1 MiB e o stdout de protocolo a 8 MiB. Logs continuam separados no stderr, cujo histórico preserva somente a cauda mais recente de 256 KiB. Esses processos reduzem interferência entre operações, mas não constituem um sandbox do sistema operacional: um plugin local ainda executa com os acessos concedidos ao usuário atual.

Em `ingest`, o plugin devolve somente descritores temporários de artefatos. Antes de entregar a lease ao consumidor, o host valida que cada caminho permanece no diretório temporário canônico, aponta para um arquivo regular, tem tamanho e SHA-256 declarados corretos e respeita os limites agregados. A lease termina quando o consumidor conclui, inclusive se houver erro, e seus arquivos são removidos. Em cancelamento, o host pede cancelamento cooperativo e aguarda a resposta terminal por um período curto; se o processo não encerrar, força o término. No Windows, cada plugin nasce sob um supervisor privado que entra em um Job Object com `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` antes de iniciar o comando do plugin. Encerrar o supervisor fecha o Job Object e elimina toda a árvore, inclusive descendentes que conservaram pipes depois que o processo direto do plugin saiu. A ausência ou incompatibilidade do addon interrompe o lançamento com `PLUGIN_SUPERVISOR_UNAVAILABLE`, sem fallback mais fraco. Isso é controle de ciclo de vida, não sandbox: plugins locais continuam com os acessos do usuário atual.

Publicações concorrentes usam um claim exclusivo por raw. No Windows, uma breve disputa com rename ou remoção desse claim é repetida de modo limitado; falhas de acesso que persistem continuam sendo devolvidas como erro.

A descoberta de plugins mantém o inventário diagnosticável: cada entrada fica como `ready`, `invalid`, `incompatible` ou `collision`, inclusive quando o manifesto não pode ser lido. O último diagnóstico de saúde é `healthy`, `unhealthy` ou `unchecked`; ele só é reutilizado quando identificador, versão e digest do manifesto coincidem exatamente. A seleção filtra a capacidade solicitada, faz probes em ordem estável e escolhe maior confiança, depois prioridade. Empates exatos não são escolhidos implicitamente: retornam os candidatos ordenados por identificador. O doctor executa somente `healthcheck` para entradas prontas, persiste o resultado e suas remediações; para entradas inválidas, incompatíveis ou em colisão devolve o diagnóstico e a remediação sem executar código do plugin.

Um plugin TypeScript define as quatro operações primárias e o cancelamento cooperativo, depois entrega o controle ao runner:

```ts
import { definePlugin, runPlugin } from '@sheldon/plugin-sdk';

const plugin = definePlugin({
  describe: async () => description,
  probe: async ({ input }) => probe(input),
  ingest: async (request, context) => ingest(request, context.signal),
  healthcheck: async (context) => {
    context.log('plugin saudável');
    return { checks: [] };
  },
  cancel: async (targetRequestId) => cancel(targetRequestId),
});

await runPlugin(plugin);
```

O `runPlugin` lê envelopes JSONL de stdin, mantém uma operação primária por processo e aceita um pedido de cancelamento enquanto ela estiver pendente. Respostas de protocolo são escritas exclusivamente em stdout; mensagens humanas emitidas por `context.log` usam stderr.

O `npm run coverage` mede todo o TypeScript em `apps/**/src` e `packages/**/src`, inclusive arquivos não alcançados pelos testes, com o provider V8 local do Vitest. O gate exige no mínimo 80% de statements, functions e lines e 70% de branches. Os relatórios text, JSON e HTML são gerados localmente em `coverage/`; `npm run verify` executa esse gate depois da suíte rápida de testes.

Comandos individuais:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run lint:md`
- `npm test`
- `npm run coverage`
- `npm run verify:plugin-contract`
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
    plugin-state.db
```

`doctor` não modifica o vault. Se `operations.db` estiver ausente ou corrompido, ele explica como reconstruir o estado operacional sem remover os arquivos de conhecimento.

`plugin-state.db` guarda o último estado de saúde reconstruível de cada plugin e os 10.000 resumos de execução sanitizados mais recentes; não é fonte de verdade para o conhecimento do vault.

## Primeira memória (M2)

O fluxo inicial do M2 trabalha com um arquivo local de um tópico ou projeto já existente. A ingestão grava um raw imutável em `raw/<source-id>/`, com `manifest.yaml`, o original preservado e `content.md` normalizado. A resposta JSON do comando informa o `sourceId` e o caminho de `content.md`; use-os no passo de compilação.

```powershell
npm run build
npm run sheldon -- ingest file topic agentes-locais C:\inbox\nota.md --vault C:\knowledge\sheldon
```

Compile a fonte com um agente por execução. O exemplo usa Codex; substitua `codex` por `claude` para executar a mesma proposta com Claude Code. Ambos devem estar instalados, autenticados e disponíveis no `PATH`.

```powershell
npm run sheldon -- compile topic agentes-locais nota-inicial `
  --agent codex `
  --prompt "Integre a fonte à wiki com citações de raw." `
  --raw raw/<source-id>/content.md `
  --vault C:\knowledge\sheldon
```

`compile` salva a proposta e seus metadados em `outputs/proposals/<proposal-id>/`; ele não altera a wiki aprovada. Antes de promover conteúdo, liste a prévia e escolha cada arquivo individualmente. A aprovação aceita somente os caminhos exibidos pela proposta, sob `wiki/`.

```powershell
npm run sheldon -- review preview topic agentes-locais nota-inicial --vault C:\knowledge\sheldon
npm run sheldon -- review approve topic agentes-locais nota-inicial wiki/nota-inicial.md --vault C:\knowledge\sheldon
```

Arquivos não passados a `review approve` permanecem fora da wiki. Propostas que tentam mudar `raw/` ou `system/`, que não citam um raw existente ou que saem de `wiki/` são rejeitadas. O preview inclui diff, fontes, afirmações, contradições e confiança; `review lint` valida links, órfãos, fontes e schema da wiki.

```powershell
npm run sheldon -- agent doctor codex
npm run sheldon -- review lint topic agentes-locais --vault C:\knowledge\sheldon
npm run sheldon -- review reject topic agentes-locais nota-inicial --reason "Fonte insuficiente" --vault C:\knowledge\sheldon
npm run sheldon -- compile-retry topic agentes-locais nota-revisada --from nota-inicial --agent claude --prompt "Revise a proposta" --raw raw/<source-id>/content.md --vault C:\knowledge\sheldon
```

`agent doctor` verifica presença, versão e sessão utilizável sem expor credenciais. Rejeições e novas tentativas ficam vinculadas aos artefatos da proposta em `outputs/proposals/`.

## Ingestão oficial de arquivos (M3)

O comando `ingest file` descobre plugins com a capacidade `ingest-file`, executa os probes em ordem estável e seleciona automaticamente a melhor opção compatível. O plugin oficial `source.file` reconhece o formato sem exigir uma opção de formato. Para escolher explicitamente um plugin compatível, use `--plugin`:

```powershell
npm run sheldon -- ingest file topic agentes-locais C:\inbox\relatorio.pdf `
  --plugin source.file `
  --vault C:\knowledge\sheldon
```

O plugin oficial aceita PDF, DOCX, PPTX, XLSX, EPUB, HTML (`.html`, `.htm` e `.xhtml`), JSON, YAML, Markdown e texto `.txt`. O original é sempre preservado; formatos não suportados são rejeitados com diagnóstico explícito em vez de produzir texto inventado. Imagens não são aceitas por `source.file`, pois a ingestão de imagens e o OCR pertencem a `source.image`.

Cada captura é publicada atomicamente dentro da entidade escolhida:

```text
raw/<source-id>/
  manifest.yaml
  original.<extensão>
  content.md
  assets/                 # somente quando o extrator produzir assets
```

O `source-id` deriva por SHA-256 dos bytes originais e das opções relevantes serializadas de forma estável. Repetir a mesma entrada com as mesmas opções devolve o raw existente. Quando o conteúdo da mesma URI canônica muda com as mesmas opções, Sheldon cria outro raw e registra `previous_source_id` no novo `manifest.yaml`, formando o vínculo de versão sem alterar capturas anteriores.

Todos os extratores embarcados de `source.file` funcionam offline. Seu manifesto declara `network: false` e `cookies: false`; a ingestão, o probe e o healthcheck não baixam engines, modelos nem conteúdo e não exigem API paga. OCR não é uma capacidade de `source.file`.

```powershell
npm run sheldon -- plugin doctor source.file
```

## Ingestão de uma URL pública

O comando `ingest url` captura uma única página pública por execução e publica a resposta original junto do Markdown normalizado. Ele aceita somente URLs absolutas HTTP(S), sem credenciais ou fragmentos:

```powershell
npm run sheldon -- ingest url topic agentes-locais https://example.com/artigo `
  --vault C:\knowledge\sheldon
```

A captura segue no máximo cinco redirecionamentos, revalidando cada destino, e limita a resposta a 5 MiB. Endereços locais, privados, link-local, não especificados e multicast são recusados. Somente HTML/XHTML, texto simples e Markdown são aceitos.

Cada invocação processa apenas a página informada: não percorre links, não autentica, não envia cookies e não contorna paywalls ou DRM. Para escolher explicitamente outro plugin compatível, use `--plugin <id>`.

## Crawl público limitado (M3)

Para capturar uma fatia limitada de um site público, use o comando separado `ingest crawl`. Os limites são obrigatórios: no máximo 1 a 10 tentativas de páginas e profundidade de 0 a 2.

```powershell
npm run sheldon -- ingest crawl topic agentes-locais https://example.com/guia `
  --max-pages 10 `
  --max-depth 2 `
  --vault C:\knowledge\sheldon
```

O crawl usa `source.url` com a capacidade `ingest-site`. Ele começa na URL pública informada e restringe a travessia ao origin efetivo, preservando um inventário determinístico de URLs visitadas, puladas e com falha. Não autentica, não envia cookies e não contorna paywalls ou DRM. `ingest url` permanece uma captura de página única.

## Vídeo único do YouTube com legendas (M3)

O mesmo comando `ingest url` seleciona automaticamente `source.youtube` para uma URL pública HTTPS de um único vídeo do YouTube; páginas comuns continuam selecionando `source.url`. Ao instalar `source.youtube` pelo catálogo oficial, o runtime verificado do [yt-dlp](https://github.com/yt-dlp/yt-dlp) vem no artefato específico da plataforma e fica privado ao plugin. Não há instalação manual, `PATH` global ou atualização implícita.

```powershell
npm run sheldon -- ingest url topic agentes-locais https://youtu.be/AbCdEf12345 `
  --language en,pt `
  --vault C:\knowledge\sheldon
```

`--language <tags>` é uma preferência opcional de tags BCP-47 separadas por vírgula; sem ela, o plugin prefere `pt,en`. Para cada idioma preferido, ele usa uma legenda manual utilizável antes de uma legenda automática. A captura consulta metadados e legendas com `yt-dlp --skip-download`: não baixa mídia, não usa STT e não baixa modelos automaticamente. STT local está adiado. Se não houver legenda utilizável nos idiomas pedidos, tente outro idioma ou forneça uma fonte com legendas. Playlists e canais não fazem parte do escopo atual.

## Snapshot de repositório Git local (M3)

O comando `ingest repository` seleciona um plugin com a capacidade `ingest-repository`. O plugin
oficial `source.repository` exige uma instalação local do Git e aceita somente um worktree local
legível, sem links simbólicos, com `HEAD` resolvido e cujos arquivos regulares no checkout sejam
byte por byte idênticos à árvore confirmada em `HEAD`:

```powershell
npm run sheldon -- ingest repository topic agentes-locais C:\src\meu-repositorio `
  --vault C:\knowledge\sheldon
```

A captura lê os blobs rastreados diretamente do commit em `HEAD`, sem usar o conteúdo mutável dos
arquivos do worktree. A seleção determinística considera apenas extensões de texto e código, com
limites fixos de 500 arquivos, 1 MiB por arquivo e 10 MiB agregados. O raw publicado contém o
original de metadados do commit, `content.md` e o inventário `assets/tree.json`; repetir o mesmo
commit deduplica a captura, e um commit seguinte recebe `previous_source_id`.

Essa seleção tem orçamento próprio e acontece somente depois da validação bruta do checkout. A
validação percorre no máximo 10.000 entradas de diretório fora de `.git` e calcula até 64 MiB
agregados de arquivos regulares; exceder qualquer limite retorna
`REPOSITORY_GIT_OUTPUT_LIMIT`, sem classificar o worktree como sujo.

Todos os blobs selecionados são verificados antes da materialização. Se um padrão de segredo de
alta confiança for detectado, a operação retorna `REPOSITORY_SECRET_DETECTED`, não inclui o valor no
diagnóstico e não publica nenhum raw.

Esta fatia é estritamente local e offline: não acessa remotos nem a rede Git. Ela não clona URLs,
autentica em remotos, percorre submódulos, materializa Git LFS ou aceita qualquer diferença bruta
no checkout. Configurações inativas de filtros personalizados não são executadas nem recusadas por
si só; somente conversões de checkout — por `core.autocrlf`, atributos `eol`, filtros ou outro
mecanismo — que deixem os bytes diferentes dos blobs de `HEAD` são incompatíveis. Clone remoto e
ingestão de repositórios hospedados continuam pendentes. Para escolher explicitamente outro plugin
compatível, use `--plugin <id>`.

## Plugins

Os dados da plataforma vivem em `%APPDATA%\Sheldon` e não no vault de conhecimento:

```text
%APPDATA%\Sheldon\
  plugins\                 # cópias locais instaladas, uma raiz por identificador
  plugin-registry.yaml      # registro atômico de instalação
  plugin-state.db           # saúde e resumos de execução reconstruíveis
```

Compile antes de usar os comandos. O catálogo remoto é opt-in para descoberta; instalações oficiais e downloads de idiomas são ações explícitas:

```powershell
npm run build
npm run sheldon -- plugin list --remote
npm run sheldon -- plugin info source.image --remote
npm run sheldon -- plugin install source.image
npm run sheldon -- image language install deu
npm run sheldon -- plugin list
npm run sheldon -- plugin doctor source.image
npm run sheldon -- plugin test C:\plugins\meu-plugin
npm run sheldon -- plugin remove source.image
```

`plugin list` lê apenas o registro local. Quando um catálogo oficial assinado estiver publicado e acessível, `plugin list --remote` e `plugin info <id> --remote` poderão carregá-lo e mostrar a disponibilidade por plataforma e o estado local, sem persistir uma instalação. Nesse caso, `plugin install <id>` aceitará somente um identificador oficial presente no catálogo e validará o artefato antes da instalação; não aceita URLs ou diretórios arbitrários, nem executa scripts ou instala dependências. Se houver um artefato de idioma catalogado para `source.image`, `image language install <code>` poderá instalá-lo; `por` e `eng` são idiomas-base. `doctor` só executa `healthcheck` para entradas `ready` e apresenta `healthy`, `unhealthy` ou `unchecked`; a última saúde é reutilizada apenas quando identificador, versão e digest do manifesto ainda coincidem, portanto pode aparecer como estado conhecido anterior até a próxima verificação. `test` roda o contrato reutilizável contra uma raiz de plugin. `remove` só remove uma instalação local registrada. Esses comandos, quando houver catálogo e artefatos disponíveis, apenas os consomem: não publicam plugins, não criam releases e não retomam a manutenção do runtime nativo de OCR.

## Padrões do repositório

- Commits seguem [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): descrição`.
- Toda mudança relevante atualiza o [CHANGELOG](CHANGELOG.md).
- Mudanças de comportamento, instalação, comandos, configuração, arquitetura ou estrutura documental atualizam este README ou o README mais próximo no mesmo commit.
- Lint, formatação, typecheck e testes aplicáveis devem passar antes do commit.
- PRDs e planos não substituem documentação de uso; quando uma entrega se torna executável, seus comandos e exemplos entram no README.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os gates completos.
