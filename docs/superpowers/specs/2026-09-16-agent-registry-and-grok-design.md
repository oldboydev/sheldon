# Design — Registro de agentes e Grok CLI

## Decisão

O runtime deixa de ramificar em `'codex' | 'claude'`. Codex, Claude e Grok passam a ser
três perfis de uma tabela built-in. Grok entra como terceiro worker (`compile` / `query`) e
como terceiro consumidor MCP/skill. O Sheldon continua sem chamar API de modelo: só dispara
CLIs locais já autenticados pelo usuário.

Esta fatia não cria adapter genérico configurável pelo usuário. O registro é fechado no
código. O quarto agente futuro adiciona uma linha na tabela; não espalha outro union.

## Problema

`AgentKind`, `AgentCommand.executable`, metadados de proposta, schema de query, CLI, jobs da
web e instalação de skill repetem `'codex' | 'claude'` em cerca de quinze arquivos. Acrescentar
`'grok'` nessa união funciona uma vez e torna o quarto agente mais caro.

O Grok CLI já oferece o contrato que o runtime precisa: modo headless, JSON Schema, sandbox
somente leitura e MCP stdio. Sem perfil próprio, `--agent grok` é recusado e
`mcp configure` não escreve `.grok/config.toml`.

## Escopo

- Tabela de perfis em `@sheldon/agent-runtime`, fonte única dos ids conhecidos.
- `AgentKind` derivado dessa tabela.
- Worker Grok para `compile`, `compile-retry`, `query` e promoção de resposta.
- Healthcheck `sheldon agent doctor [grok]` e aviso em `sheldon doctor`.
- Consumidor Grok: merge de MCP em `<consumer>/.grok/config.toml` e skill em
  `<consumer>/.grok/skills/sheldon`.
- Superfície CLI e select da web local.
- Allowlist de ambiente por perfil, para o filho achar auth sem o host logar segredo.
- Documentação pública, changelog, PRDs 004/007 e ADR no registro de decisões.

## Fora de escopo

- Chamada direta à API xAI, OpenAI ou Anthropic.
- Adapter genérico “qualquer executável”.
- Escolha automática de agente por preço, latência ou qualidade.
- Escrita do agente na wiki aprovada.
- Detecção real de `agentVersion` (continua `unknown` até uma fatia própria).
- Mudar o significado de `--agent both` (permanece Codex + Claude).
- Default implícito de agente: `compile` e `query` continuam a exigir `--agent`.
- Busca vetorial, STT, Git remoto ou outros itens do “depois do MVP”.

## Evidência do CLI Grok (2026-09-16)

Spike local com Grok autenticado:

1. `--json-schema` **não** aceita caminho de arquivo (`invalid JSON: expected value at
line 1 column 1`). O schema vai como string JSON no argv.
2. `--json-schema` implica `--output-format json`. Stdout é **um** objeto JSON.
3. O payload estruturado está em `structuredOutput` (camelCase). `text` é a mesma carga
   serializada como string. Não usar o envelope raiz como proposta: ele tem campos extras
   (`stopReason`, `usage`, `sessionId`).
4. `--prompt-file` funciona. Prompts longos não vão no argv.
5. `--permission-mode plan` e `--sandbox read-only` completam com exit 0.
6. Não existe `grok login status`. Disponibilidade é `grok --version`. Autenticação é
   presença de `XAI_API_KEY` ou do arquivo `auth.json` no Grok home, **sem ler o conteúdo**.

Os schemas atuais de proposta e query cabem no limite de argv do Windows (~8191) com folga.
Um teste de contrato falha se `JSON.stringify(schema)` ultrapassar 4000 bytes, para restar
margem ao restante da linha de comando.

## Registro de perfis

Arquivo novo: `packages/agent-runtime/src/profiles.ts`.

```ts
export const AGENT_PROFILE_IDS = ['codex', 'claude', 'grok'] as const;
export type AgentKind = (typeof AGENT_PROFILE_IDS)[number];

export type AgentOutputParser = 'codex-jsonl' | 'claude-json' | 'grok-json';

export interface AgentProfile {
  readonly id: AgentKind;
  readonly label: string;
  readonly executable: AgentKind;
  readonly arguments: readonly string[];
  readonly appendPrompt: boolean;
  readonly parser: AgentOutputParser;
  readonly timeoutMilliseconds: number;
  readonly envAllowlist: readonly string[];
  readonly health: {
    readonly versionArguments: readonly string[];
    readonly authentication: 'codex-login-status' | 'claude-auth-status' | 'grok-auth-store';
  };
  readonly consumer: {
    readonly skillDirectory: string;
    readonly mcpConfigRelativePath: string;
  };
}

export function isAgentKind(value: string): value is AgentKind;
export function requireAgentProfile(id: AgentKind): AgentProfile;
export function listAgentProfiles(): readonly AgentProfile[];
```

`executable` permanece igual ao id (`codex`, `claude`, `grok`). Overrides de caminho
continuam em `JsonCommandExecutorOptions.executables`, já existente.

Placeholders resolvidos pelo executor, além dos dois atuais:

| Placeholder                    | Substituição                            |
| ------------------------------ | --------------------------------------- |
| `{sheldon-output-schema-file}` | arquivo temp do schema (Codex)          |
| `{sheldon-last-message-file}`  | arquivo temp da última mensagem (Codex) |
| `{sheldon-output-schema-json}` | `JSON.stringify(schema)` inline (Grok)  |
| `{sheldon-prompt-file}`        | arquivo temp UTF-8 do prompt (Grok)     |

`appendPrompt: true` (Codex/Claude) continua a acrescentar `--` e o prompt no argv.
`appendPrompt: false` (Grok) não acrescenta; o prompt só existe via `{sheldon-prompt-file}`.

Factories atuais (`createCodexCommandAdapter`, `createClaudeCommandAdapter` e equivalentes
de query) permanecem como wrappers. Call sites novos usam:

```ts
createCommandAdapter(requireAgentProfile(kind), executor);
createQueryCommandAdapter(requireAgentProfile(kind), executor);
```

`promoteAnswer` deixa de ramificar em `answer.agent === 'codex'`; usa o perfil do agente
persistido na resposta.

## Perfis built-in

### Codex (comportamento atual)

- argumentos: `exec --json --sandbox read-only --output-schema {sheldon-output-schema-file} --output-last-message {sheldon-last-message-file}`
- `appendPrompt: true`, parser `codex-jsonl`, timeout 120_000
- health: `codex --version` e `codex login status`
- consumidor: `.codex/config.toml` e `.codex/skills/sheldon`

### Claude (comportamento atual)

- argumentos: `--print --permission-mode plan --output-format json --json-schema {sheldon-output-schema-json}`
- `appendPrompt: true`, parser `claude-json`, timeout 120_000
- health: `claude --version` e `claude auth status`
- consumidor: `.mcp.json` e `.claude/skills/sheldon`

### Grok (novo)

- argumentos, nesta ordem:

  ```text
  --prompt-file {sheldon-prompt-file}
  --json-schema {sheldon-output-schema-json}
  --sandbox read-only
  --permission-mode plan
  --tools read_file,grep,list_dir
  --disallowed-tools search_replace,run_terminal_cmd,web_search,web_fetch
  --no-subagents
  --disable-web-search
  --no-auto-update
  --verbatim
  ```

- `appendPrompt: false`, parser `grok-json`, timeout 300_000
- `envAllowlist`: `GROK_HOME`, `XAI_API_KEY`
- health: `grok --version`; autenticação se `XAI_API_KEY` não vazio **ou** se existir o
  arquivo `join(grokHome, 'auth.json')`, onde `grokHome` é `GROK_HOME` ou
  `join(homedir(), '.grok')`. Não ler o arquivo. Não imprimir chave nem caminho com
  segredo.
- consumidor: `.grok/config.toml` e `.grok/skills/sheldon`
- recovery de doctor se o binário faltar: instalar o Grok CLI e garantir
  `%USERPROFILE%\.grok\bin` (Windows) ou o binário gerenciado no `PATH`.
- recovery se não autenticado: `grok login` ou definir `XAI_API_KEY`.

## Parser Grok

`parseGrokResponse` **não** trata o objeto raiz como payload. Ordem:

1. `structuredOutput` se for objeto;
2. `structured_output` se for objeto (compat com o stream Messages);
3. `text` se for string JSON de objeto.

Qualquer outro formato é erro genérico já usado pelo executor (“did not produce a valid
proposal/answer”). Stdout continua não sendo ecoado ao usuário.

Fixture de teste com o envelope observado no spike (`structuredOutput` + `text` string) e
uma fixture negativa do envelope sem payload.

## Ambiente do processo filho

`sanitizedEnvironment` hoje só encaminha `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`,
`LANG`, `LANGUAGE` e `LC_*`. Grok (e, na prática, Codex/Claude) precisa achar o home.

Base comum a todos os perfis, além da lista atual:

`HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TMP`, `TEMP`

Cada perfil acrescenta `envAllowlist`. Valores nunca vão para stdout/stderr do Sheldon.
Teste: um `SECRET_TOKEN` no ambiente do pai não aparece no `env` do filho nem na saída da
CLI.

`JsonCommandExecutorOptions.executables` passa a aceitar chave `grok`.

## Persistência e schemas

`ProposalMetadata.agent` e `QueryAnswer.agent` passam a `AgentKind`. Respostas e propostas
já gravadas com `codex` ou `claude` continuam válidas.

O enum JSON Schema de `queryAnswerJsonSchema.properties.agent` é gerado de
`AGENT_PROFILE_IDS`. A versão do schema permanece `1`: é alargamento compatível.

`validateQueryAnswer` recusa agente fora do registro. Não aceitar string livre.

## CLI

`--agent` em `compile`, `compile-retry`, `query` e `agent doctor` aceita qualquer
`AgentKind`. Mensagem de erro lista os ids: `codex, claude, or grok`.

`mcp install-skill --agent`:

| Valor    | Destinos                    |
| -------- | --------------------------- |
| `codex`  | `.codex/skills/sheldon`     |
| `claude` | `.claude/skills/sheldon`    |
| `grok`   | `.grok/skills/sheldon`      |
| `both`   | Codex + Claude (inalterado) |
| `all`    | Codex + Claude + Grok       |

Default de `install-skill` permanece `both`.

`sheldon doctor` passa a reportar Grok CLI como reporta Codex e Claude.

Help e README mostram `--agent grok` como alternativa explícita, sem torná-lo default.

## MCP consumidor

`sheldon mcp configure` continua a escrever `.sheldon/mcp.yaml`, `.codex/config.toml` e
`.mcp.json`. Passa também a mesclar o servidor Sheldon em
`<consumer>/.grok/config.toml`:

```toml
[mcp_servers.sheldon]
command = "sheldon"
args = ["mcp", "serve", "--consumer-config", "<absolute-mcp-yaml>"]
```

Regras de merge (espelham Claude, não Codex):

- Arquivo ausente: criar somente com a tabela `mcp_servers.sheldon`.
- Arquivo existente e parseável: gravar/substituir só `mcp_servers.sheldon`; demais chaves
  intactas.
- `mcp_servers.sheldon` já existe com `command`/`args` diferentes do esperado: recusar,
  como Claude recusa chave `sheldon` já presente.
- TOML ilegível: recusar com recovery para corrigir o arquivo.
- Preview lista o conteúdo proposto. `--apply` é que escreve.
- Rollback restaura o bytes originais de `.grok/config.toml` (ou apaga se o arquivo não
  existia), no mesmo espírito do rollback de `.mcp.json`.

Parser/serializer: promover `smol-toml` a dependência direta de `apps/cli`. Já está no
lockfile como transitiva; licença BSD-3-Clause, compatível com ADR-010. Não inventar merge por
regex.

`sheldon mcp doctor` acrescenta duas linhas de warning, no mesmo tom das atuais:

- `Grok project config: matches expected | not configured (warning)`
- `Grok skill: installed | not installed (warning)`

Não falha o doctor se Grok não estiver configurado. Codex e Claude já são warnings.

Não invocar `grok mcp add`: a configuração tem de ser testável sem o binário Grok.

## Web local

`WebJobRequest` de `compile` e `query` usa `AgentKind`. `validAgent` consulta
`isAgentKind`. O select em `App.tsx` ganha a opção Grok. Default visual permanece Codex.

## Testes obrigatórios

1. **Registro:** `isAgentKind` aceita os três ids e recusa `both`, `all` e lixo.
2. **Executor Grok (fixture):** spawn de um executável falso que valida argv
   (`--prompt-file`, `--json-schema` inline, `--sandbox read-only`, sem prompt solto no
   argv) e imprime o envelope `structuredOutput` observado no spike; o runtime grava
   proposta `pending`.
3. **Parser negativo:** envelope sem `structuredOutput` / `text` JSON vira `error`, sem
   vazar stdout.
4. **Ambiente:** `SECRET_TOKEN` não é encaminhado; `XAI_API_KEY` e `USERPROFILE` são
   quando o perfil Grok roda.
5. **Schema argv:** `JSON.stringify` dos dois schemas oficiais tem comprimento ≤ 4000.
6. **CLI:** `--agent grok` é aceito; `--agent cursor` falha com a lista dos ids.
7. **Doctor:** probe injetado para Grok; recovery de binário ausente não imprime segredo.
8. **Query/compile de aceitação:** o mesmo padrão M2 que já cobre Codex e Claude cobre
   Grok via executor injetado.
9. **MCP configure:** preview não escreve; `--apply` cria `.grok/config.toml`; merge
   preserva uma chave irrelevante já presente; recusa `mcp_servers.sheldon` conflitante;
   rollback restaura o original.
10. **install-skill --agent grok** e `--agent all`.
11. **Web:** job `compile` com `agent: "grok"` é válido; `"cursor"` não.

Teste live contra o binário `grok` é opcional e skip se o executável não estiver no PATH.
CI não depende dele. A fixture é o contrato.

## Documentação a atualizar na mesma entrega

- `README.md`: exemplo `--agent grok` e nota de MCP/skill Grok.
- `CHANGELOG.md` seção Unreleased.
- `docs/prds/004-agent-runtime-and-review.md`: workers = Codex, Claude e Grok CLI.
- `docs/prds/007-agent-integration-mcp-and-skill.md`: consumidor Grok
  (`.grok/config.toml` + `.grok/skills/sheldon`); `--agent both` permanece os dois
  originais; `all` inclui Grok.
- `docs/product/architecture.md` e `docs/product/vision.md`: Grok como CLI opcional
  equivalente, sem API xAI no núcleo.
- `docs/product/decisions.md`: ADR-014 — perfis built-in em vez de union espalhado;
  Grok é linha da tabela, não integração especial.
- Help da CLI (`main.ts`) gerado a partir dos ids do registro.

## Compatibilidade

- Propostas e answers existentes com `agent: "codex" | "claude"` carregam.
- `--agent both` não passa a incluir Grok.
- Default de `install-skill` permanece `both`.
- `mcp configure --apply` passa a criar/mesclar `.grok/config.toml`. Testes de MCP que
  hoje só esperam Codex/Claude precisam passar a esperar o arquivo Grok no preview.
- Nenhuma migração de vault. SQLite operacional não guarda o id do agente como enum
  SQL; o valor vive em JSON de proposta/answer.

## Riscos e mitigações

| Risco                                        | Mitigação                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Grok muda `structuredOutput` para snake_case | Parser aceita os dois nomes de campo                                                   |
| Schema JSON estoura argv no Windows          | Gate de 4000 bytes; `--prompt-file` já tira o prompt da linha                          |
| `auth.json` ausente com login via API        | `XAI_API_KEY` na allowlist do filho, nunca logada                                      |
| Merge TOML corrompe config do usuário        | Parser real; recusa ilegível; rollback de bytes                                        |
| Timeout 120s curto para compile Grok         | 300s só no perfil Grok                                                                 |
| Grok tenta editar o vault                    | sandbox read-only, permission plan, denylist de write/shell, validação de path `wiki/` |

## Verificação de pronto

A fatia só fecha quando:

- `npm run verify` passa;
- `--agent grok` em compile/query/doctor é exercitado por teste;
- `mcp configure --apply` e `mcp install-skill --agent grok` são exercitados por teste;
- README, changelog e help listam Grok;
- nenhum call site de produto ainda contém o union literal `'codex' \| 'claude'` para
  agente (exceto aliases `both` de skill e fixtures históricas de JSON já persistido
  nos testes).
