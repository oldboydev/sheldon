<!-- markdownlint-disable MD029 MD034 MD060 -->

# Local STT fallback for YouTube when captions are missing

> Build this with **tlc-implement**.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Quem ingere um vídeo público do YouTube sem legenda utilizável paga com uma falha que afirma que
o fallback de STT local “não está implementado”. `source.youtube` declara `effects.stt: false`,
então `sheldon ingest url --stt` é recusado com `PLUGIN_OPTION_UNSUPPORTED` antes de qualquer
runtime. A mensagem de `YOUTUBE_CAPTIONS_UNAVAILABLE` e a recovery do host repetem “fallback is
not implemented” e pedem outra língua ou uma fonte legendada. O PRD 003 já pedia: vídeo sem
legenda informa a opção local e falha de forma acionável quando ela não está instalada. O
Instagram já tem esse contrato (`effects.stt: true`, `--stt`, `SHELDON_LOCAL_STT_*`, 50 MiB,
doctor com aviso opcional). A issue não dá volume de suporte.

Depois da mudança, o mesmo `--stt` que o Instagram aceita passa a ser aceito em
`source.youtube`. Com legendas, o caminho continua caption-first. Sem legendas e sem `--stt`, a
falha continua `YOUTUBE_CAPTIONS_UNAVAILABLE`, agora nomeando `--stt` e as env vars. Sem
legendas, com `--stt` e runtime local válido, o transcript publicado em `content.md` vem do
executável configurado. Sem runtime válido, a falha é acionável e nenhum raw é publicado.

8 criteria in 4 slices · 3 one-way doors · 1 open, of which 0 block

Sizing evidence: CONTRIBUTING não declara tamanho de task; a issue #37 é uma; default é uma
task. As fatias compartilham o mesmo plugin, o mesmo host e o mesmo contrato de env.

## Criteria

### Caption-first

1. Dado um vídeo do YouTube com legenda utilizável e `--stt`, quando `source.youtube` ingere,
   então o `content.md` usa o texto da legenda, o executável de STT não é invocado e nenhum
   download de áudio STT ocorre.
2. Dado um vídeo sem legenda utilizável e sem `--stt`, quando `source.youtube` ingere, então a
   falha é `YOUTUBE_CAPTIONS_UNAVAILABLE`, nenhum raw é publicado, e a mensagem mais a recovery
   do host nomeiam `--stt`, `SHELDON_LOCAL_STT_EXECUTABLE` e `SHELDON_LOCAL_STT_ARGUMENTS` e não
   contêm “fallback is not implemented”.

### STT fallback

3. Dado um vídeo sem legenda utilizável, `--stt` e ausência de `SHELDON_LOCAL_STT_EXECUTABLE`,
   quando `source.youtube` ingere, então a falha é `YOUTUBE_STT_UNAVAILABLE`, nenhum modelo é
   baixado e nenhum raw é publicado.
4. Dado um vídeo sem legenda utilizável, `--stt` e um executável local configurado, quando
   `source.youtube` ingere, então `content.md` contém o transcript stdout desse processo, o
   áudio temporário fica sob 50 MiB (`--max-filesize` `50M` e rejeição acima de
   `50 * 1024 * 1024` bytes), `{input}` é substituído pelo caminho do áudio, o spawn usa
   `shell: false`, e nenhum modelo é baixado.
5. Dado `--stt` e `SHELDON_LOCAL_STT_ARGUMENTS` inválido (JSON que não é array de strings com no
   máximo um `{input}`), quando não há legenda utilizável e `source.youtube` ingere, então a
   falha é `YOUTUBE_STT_CONFIGURATION_INVALID` e nenhum raw é publicado.

### CLI option

6. Quando `sheldon ingest url --plugin source.youtube --stt` corre contra um `source.youtube`
   que declara `effects.stt: true`, então o código não é `PLUGIN_OPTION_UNSUPPORTED`.

### Doctor

7. Dado `SHELDON_LOCAL_STT_EXECUTABLE` ausente, quando `source.youtube` executa `healthcheck`,
   então existe um check `id: local-stt` com `severity: warning` e
   `message: Local STT is optional and no model is downloaded automatically.`, e o check
   `id: yt-dlp` permanece o diagnóstico atual de versão (saudável ou erro do probe).
8. Sempre, um `healthcheck` de `source.youtube` com somente o aviso `local-stt` (sem check
   `error`) não torna o plugin unhealthy.

## Out of scope

- Git remoto / clone autenticado — a issue exclui
- Playlists e canais do YouTube — a issue exclui
- Embarcar ou baixar automaticamente um modelo STT (Whisper etc.) — a issue exclui
- Mudar o comportamento STT do Instagram, salvo extrair o contrato já existente — a issue exclui
- LinkedIn vídeo / OCR — a issue exclui
- Omissão do catálogo oficial no macOS (ADR-017) — a issue exclui
- APIs pagas de transcrição, cookies para YouTube, bypass de DRM/paywall — a issue exclui

## Observable

| Surface                                        | Decision                    | Landing                                                                          |
| ---------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| command `sheldon ingest url`                   | output format and verbosity | existing - JSON de publicação no stdout; diagnóstico no stderr                   |
| command `sheldon ingest url`                   | flags and defaults          | 6 - `--stt` já existe; `source.youtube` passa a declará-lo                       |
| command `sheldon ingest url`                   | exit codes                  | 2, 3, 5, 6 - 1 nas falhas estáveis; `PLUGIN_OPTION_UNSUPPORTED` deixa de aplicar |
| command `sheldon ingest url`                   | failure halfway             | 2, 3, 5 - nenhum raw publicado                                                   |
| command `sheldon plugin doctor source.youtube` | output format and verbosity | existing - doctor imprime os checks do `healthcheck`                             |
| command `sheldon plugin doctor source.youtube` | flags and defaults          | n/a - nenhum flag novo                                                           |
| command `sheldon plugin doctor source.youtube` | exit codes                  | 8 - warning não é unhealthy                                                      |
| command `sheldon plugin doctor source.youtube` | failure halfway             | existing - check `yt-dlp` `error` continua unhealthy                             |
| document CHANGELOG Unreleased                  | structure and next action   | existing - política de changelog do repositório                                  |
| document `apps/cli/help/pages/ingest.md`       | `--stt` copy                | existing - a flag já está documentada para `ingest url`                          |

## Swept

- validation: 5, 6 - `stt` boolean nas options; `SHELDON_LOCAL_STT_ARGUMENTS` JSON array com no máximo um `{input}`
- failure modes: 2, 3, 5
- idempotency and retry: existing - ingestão YouTube já é um raw imutável; esta fatia não muda dedup
- authorization: n/a - plugin local, sem auth; YouTube continua sem cookies
- concurrency and ordering: n/a - um ingest por processo de plugin
- data lifecycle: n/a - áudio STT é temporário no diretório do plugin; nenhum raw extra permanente além dos artefatos já publicados
- external-dependency failure: 3, 4, 7 - runtime STT ausente/inválido; yt-dlp do doctor inalterado
- state transitions: n/a - nenhum ciclo de vida persistido muda
- observability: 2, 3, 5, 7 - códigos estáveis e checks de doctor

## Impact

| Front       | What changes                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| domain      | existing term: `effects.stt` em `source.youtube` significava `false` (CLI recusa `--stt`); passa a `true` - `ingestUrl` em `apps/cli/src/commands/memory.ts` ramifica em `supportsStt`; `PluginProcessRunner` encaminha `SHELDON_LOCAL_STT_*` só quando `effects.stt === true` |
| domain      | new term: `YOUTUBE_STT_UNAVAILABLE` - `--stt` sem runtime local válido na ausência de legenda, vive no plugin YouTube e no mapa de recovery do host                                                                                                                            |
| domain      | new term: `YOUTUBE_STT_CONFIGURATION_INVALID` - `--stt` com `SHELDON_LOCAL_STT_ARGUMENTS` inválido na ausência de legenda, vive no plugin YouTube e no mapa de recovery do host                                                                                                |
| domain      | new term: `YOUTUBE_MEDIA_LIMIT_EXCEEDED` - áudio STT acima de 50 MiB ou yt-dlp sem input dentro do limite, vive no plugin YouTube (mesmo papel de `INSTAGRAM_MEDIA_LIMIT_EXCEEDED`)                                                                                            |
| domain      | existing term: `YOUTUBE_CAPTIONS_UNAVAILABLE` continua a falha sem `--stt`; o texto deixa de dizer que o fallback não está implementado - `forwardedSourceDiagnostic` e `selectYoutubeCaption`                                                                                 |
| stored data | nothing to migrate                                                                                                                                                                                                                                                             |

## Decided

| Decision           | Shape                                                                                                                                                                                                                                                                                                                                              | Alternative rejected                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrato de env    | Reutilizar `localSttConfiguration` do Instagram: `SHELDON_LOCAL_STT_EXECUTABLE` (trim, vazio = unconfigured), `SHELDON_LOCAL_STT_ARGUMENTS` JSON array de strings ≤ 4096 chars, no máximo um `{input}`, zero placeholders implica append de `{input}`; spawn `shell: false`; host já allowlista as duas keys quando `effects.stt === true`         | Segundo contrato de env YouTube-only - a issue exige o mesmo contrato                                                                                           |
| Códigos estáveis   | `YOUTUBE_STT_UNAVAILABLE`, `YOUTUBE_STT_CONFIGURATION_INVALID`, `YOUTUBE_MEDIA_LIMIT_EXCEEDED`; recovery da mesma classe do Instagram (`Remove --stt or configure…`; `Set SHELDON_LOCAL_STT_EXECUTABLE and optional SHELDON_LOCAL_STT_ARGUMENTS…`) com `source.youtube` no lugar de `source.instagram`; incluir os três em `sourceDiagnosticCodes` | Reusar `INSTAGRAM_STT_*` no YouTube - o host e os testes prefixam por família                                                                                   |
| Quando validar STT | Configuração STT (ausente ou inválida) só é exigida quando não há legenda utilizável                                                                                                                                                                                                                                                               | Validação eager do Instagram (falha `--stt` sem env mesmo com caption) - a issue exige que vídeo legendado com `--stt` use a legenda e não invoque o executável |

- Helper compartilhado versus cópia no plugin YouTube é reversível. Bound de áudio 50 MiB e
  `modelDownload: false` já são o contrato Instagram.

## Surface

| Route                                                | In                              | Out                                                  | Status                                                                                                                                 | Criteria |
| ---------------------------------------------------- | ------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `sheldon ingest url … --plugin source.youtube --stt` | `url`, `stt: true`, `language?` | `content.md` transcript; ou código estável no stderr | 0; 1 `YOUTUBE_CAPTIONS_UNAVAILABLE` / `YOUTUBE_STT_UNAVAILABLE` / `YOUTUBE_STT_CONFIGURATION_INVALID` / `YOUTUBE_MEDIA_LIMIT_EXCEEDED` | 1–6      |
| `sheldon plugin doctor source.youtube`               | plugin id                       | checks `yt-dlp`, `local-stt`                         | 0 se só warning; ≠0 se `yt-dlp` error                                                                                                  | 7, 8     |

## Sources

- https://github.com/oldboydev/sheldon/issues/37 - recorte, testes, fora de escopo, evidência 0.2.4
- `docs/prds/003-core-ingestion-plugins.md` RF6 e critério adiado “Vídeo sem legenda informa a opção local disponível e falha de forma acionável quando ela não está instalada.”
- `packages/plugins/official/source.instagram/src/plugin.ts` - `localSttConfiguration`, `--stt`, 50 MiB, doctor
- `packages/plugin-host/src/process-runner.ts` - recovery `YOUTUBE_CAPTIONS_UNAVAILABLE` e allowlist `SHELDON_LOCAL_STT_*`
- `packages/plugins/official/source.youtube/src/plugin.ts` - `effects.stt: false`
- `packages/plugins/official/source.youtube/src/captions.ts` - mensagem atual de `YOUTUBE_CAPTIONS_UNAVAILABLE`

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question                                                                                                                     | Until answered                                                                                                              |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | open | Se o executável STT termina 0 com stdout vazio, publica sem transcript (Instagram) ou falha sem raw (YouTube caption-first)? | Default escrito: falha `YOUTUBE_STT_UNAVAILABLE` e não publica raw — YouTube hoje nunca publica gap; “do not invent speech” |
