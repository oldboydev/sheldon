# Sheldon

Segundo cérebro pessoal e local-first que transforma arquivos, sites, vídeos e repositórios em uma wiki Markdown cumulativa, revisável e utilizável por Codex CLI e Claude Code.

## Estado

O planejamento do produto está aprovado e a implementação do marco M0 começou pela fundação do workspace e do vault local.

Os marcos M0 e M1 estão implementados. M0 entrega o workspace, o domínio de entidades, o vault e a CLI local; M1 entrega a plataforma de plugins. O `@sheldon/plugin-sdk` é o contrato público para autores e o `@sheldon/plugin-host` instala, descobre, executa e diagnostica plugins locais sem misturar o estado operacional ao conhecimento.

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

O `npm run build` compila os workspaces com SWC para seus diretórios `dist/`. No Windows, a compilação a partir do código-fonte também usa `node-gyp` e exige Python 3, Visual Studio 2022 com a carga de trabalho **Desenvolvimento para desktop com C++** e um Windows SDK compatível. O artefato de distribuição para Windows inclui o addon privado `native/windows-job/build/Release/sheldon_job_object.node`; quem usa esse artefato não precisa recompilar o addon. O `npm test` mantém o Vitest como executor e usa SWC para transformar os arquivos TypeScript de teste e de código-fonte.

`npm run verify:plugin-contract` executa os contratos pós-build dos fixtures Node SDK e PowerShell; `npm run verify` já o inclui antes do lint de domínio.

O `@sheldon/plugin-sdk` é o contrato público schema-first para autoria de plugins. O protocolo v1 usa envelopes JSONL em UTF-8 por stdin/stdout; stdout é exclusivo do protocolo e logs devem ir para stderr.

Plugins locais são instalados exclusivamente a partir de um diretório local. Sheldon valida o manifesto e todos os links, copia os links sem segui-los para uma área privada de staging, valida novamente a árvore copiada e confirma que a identidade dessa raiz não mudou durante a publicação em `%APPDATA%\Sheldon\plugins\<id>`, antes de persistir o registro YAML atômico. Identificadores já usados por plugins oficiais ou instalados são rejeitados, sem opção de sobrescrita no M1.

A instalação apenas copia arquivos: não executa código ou scripts de pacote, não instala dependências, não faz downloads e não acessa a rede. Instalações e remoções concorrentes são serializadas por processo e por um lock exclusivo no diretório da aplicação para impedir perda de registros. O lock registra token de propriedade, PID e horário, preserva locks de processos ativos e recupera com segurança locks abandonados por processos encerrados. A remoção aceita somente um identificador registrado e apaga apenas o filho exato correspondente dentro do diretório de plugins, respeitando a comparação de caminhos sem distinção entre maiúsculas e minúsculas no Windows.

Cada operação `describe`, `probe` ou `healthcheck` inicia um processo novo com `shell: false`, diretório de trabalho na raiz do plugin e um ambiente sanitizado. Somente `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR` e variáveis de locale são encaminhadas; `TEMP` e `TMP` apontam para um diretório exclusivo da operação. Entradas e ambiente não são copiados para o histórico operacional.

O contrato de limites do host publica 10 segundos para `describe` e `probe`, 30 segundos para `healthcheck` e 15 minutos para `ingest`, destinados ao controlador de ciclo de vida. Os limites já aplicados pelo runner restringem cada linha JSONL a 1 MiB e o stdout de protocolo a 8 MiB. Logs continuam separados no stderr, cujo histórico preserva somente a cauda mais recente de 256 KiB. Esses processos reduzem interferência entre operações, mas não constituem um sandbox do sistema operacional: um plugin local ainda executa com os acessos concedidos ao usuário atual.

Em `ingest`, o plugin devolve somente descritores temporários de artefatos. Antes de entregar a lease ao consumidor, o host valida que cada caminho permanece no diretório temporário canônico, aponta para um arquivo regular, tem tamanho e SHA-256 declarados corretos e respeita os limites agregados. A lease termina quando o consumidor conclui, inclusive se houver erro, e seus arquivos são removidos. Em cancelamento, o host pede cancelamento cooperativo e aguarda a resposta terminal por um período curto; se o processo não encerrar, força o término. No Windows, cada plugin nasce sob um supervisor privado que entra em um Job Object com `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` antes de iniciar o comando do plugin. Encerrar o supervisor fecha o Job Object e elimina toda a árvore, inclusive descendentes que conservaram pipes depois que o processo direto do plugin saiu. A ausência ou incompatibilidade do addon interrompe o lançamento com `PLUGIN_SUPERVISOR_UNAVAILABLE`, sem fallback mais fraco. Isso é controle de ciclo de vida, não sandbox: plugins locais continuam com os acessos do usuário atual.

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

## Plugins

Os dados da plataforma vivem em `%APPDATA%\Sheldon` e não no vault de conhecimento:

```text
%APPDATA%\Sheldon\
  plugins\                 # cópias locais instaladas, uma raiz por identificador
  plugin-registry.yaml      # registro atômico de instalação
  plugin-state.db           # saúde e resumos de execução reconstruíveis
```

Compile antes de usar os comandos. Os cinco subcomandos são:

```powershell
npm run build
npm run sheldon -- plugin install C:\plugins\meu-plugin
npm run sheldon -- plugin list
npm run sheldon -- plugin doctor meu.plugin
npm run sheldon -- plugin test C:\plugins\meu-plugin
npm run sheldon -- plugin remove meu.plugin
```

`install` aceita somente uma pasta local e nunca executa scripts, instala dependências, baixa conteúdo ou acessa a rede. `list` mostra cada plugin descoberto como `ready`, `invalid`, `incompatible` ou `collision`. `doctor` só executa `healthcheck` para entradas `ready` e apresenta `healthy`, `unhealthy` ou `unchecked`; a última saúde é reutilizada apenas quando identificador, versão e digest do manifesto ainda coincidem, portanto pode aparecer como estado conhecido anterior até a próxima verificação. `test` roda o contrato reutilizável contra uma raiz de plugin, e `remove` só remove uma instalação local registrada — plugins oficiais não podem ser removidos por esse comando.

## Padrões do repositório

- Commits seguem [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): descrição`.
- Toda mudança relevante atualiza o [CHANGELOG](CHANGELOG.md).
- Mudanças de comportamento, instalação, comandos, configuração, arquitetura ou estrutura documental atualizam este README ou o README mais próximo no mesmo commit.
- Lint, formatação, typecheck e testes aplicáveis devem passar antes do commit.
- PRDs e planos não substituem documentação de uso; quando uma entrega se torna executável, seus comandos e exemplos entram no README.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os gates completos.
