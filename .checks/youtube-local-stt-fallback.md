<!-- markdownlint-disable MD034 MD060 -->

# Local STT fallback for YouTube when captions are missing

Sources:

- https://github.com/oldboydev/sheldon/issues/37 - recorte, testes, fora de escopo
- `.tasks/youtube-local-stt-fallback.md` - critérios 1–8, códigos `YOUTUBE_STT_*`, validação STT só sem legenda
- `packages/plugins/official/source.instagram/src/plugin.ts` - contrato `localSttConfiguration` a reutilizar

## Out of scope

- Git remoto / clone autenticado - a issue exclui
- Playlists e canais do YouTube - a issue exclui
- Embarcar ou baixar modelo STT - a issue exclui
- Mudar comportamento STT do Instagram salvo extrair o contrato - a issue exclui
- LinkedIn vídeo / OCR - a issue exclui
- ADR-017 macOS catalog - a issue exclui
- APIs pagas, cookies YouTube, DRM/paywall - a issue exclui

## Landing

`source.youtube` declara `effects.stt: true` e o contrato Instagram de env/spawn/50 MiB. Caption-first
permanece; STT só corre quando não há legenda utilizável. O host mapeia os códigos `YOUTUBE_STT_*` e
atualiza a recovery de `YOUTUBE_CAPTIONS_UNAVAILABLE`.

| One-way door       | Literal shape                                                                                                                         | Alternative rejected         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Contrato de env    | `SHELDON_LOCAL_STT_EXECUTABLE` + JSON `SHELDON_LOCAL_STT_ARGUMENTS` (array de strings, ≤1 `{input}`, spawn `shell: false`)            | contrato YouTube-only        |
| Códigos estáveis   | `YOUTUBE_STT_UNAVAILABLE`, `YOUTUBE_STT_CONFIGURATION_INVALID`, `YOUTUBE_MEDIA_LIMIT_EXCEEDED` no plugin e em `sourceDiagnosticCodes` | reusar `INSTAGRAM_STT_*`     |
| Quando validar STT | só se não há legenda utilizável                                                                                                       | validação eager do Instagram |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Caption-first · plugin + captions + host + CLI · ~40k

**C1** - Vídeo legendado com `options.stt: true` publica o texto da legenda em `content.md`, não invoca o executável STT e não baixa áudio STT (`--format` / `stt-input`).
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "uses captions and skips local STT when captions exist"`

**C2** - Vídeo sem legenda e sem `--stt` falha `YOUTUBE_CAPTIONS_UNAVAILABLE`, não publica raw, e a mensagem/recovery nomeiam `--stt`, `SHELDON_LOCAL_STT_EXECUTABLE` e `SHELDON_LOCAL_STT_ARGUMENTS` sem “fallback is not implemented”.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/captions.test.ts -t "fails with an actionable stable code when no candidate produces text"`
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "reports unavailable captions with a stable diagnostic code"`
Proof: `npx vitest run packages/plugin-host/test/process-runner-url-diagnostics.test.ts -t "maps unavailable YouTube captions to a safe actionable remediation"`
Proof: `npx vitest run apps/cli/test/url-ingestion-acceptance.test.ts -t "shows an honest actionable diagnostic when YouTube captions are unavailable"`

### S2 - STT fallback · plugin + host · ~25k

**C3** - Sem legenda, com `--stt` e sem `SHELDON_LOCAL_STT_EXECUTABLE`, falha `YOUTUBE_STT_UNAVAILABLE` e não publica raw.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "fails actionably when --stt is set without a local STT executable"`
Proof: `npx vitest run packages/plugin-host/test/process-runner-url-diagnostics.test.ts -t "maps unavailable YouTube local STT to an actionable remediation"`

**C4** - Sem legenda, com `--stt` e executável mock configurado, `content.md` contém o stdout do STT; áudio sob 50 MiB (`--max-filesize` `50M`); `{input}` substituído; `shell: false`; nenhum modelo baixado.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "runs a configured local STT runtime with a bounded local media input and never downloads a model"`

**C5** - Sem legenda, `--stt` e `SHELDON_LOCAL_STT_ARGUMENTS` inválido falha `YOUTUBE_STT_CONFIGURATION_INVALID` e não publica raw.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "reports invalid local STT configuration distinctly from an absent configuration"`
Proof: `npx vitest run packages/plugin-host/test/process-runner-url-diagnostics.test.ts -t "maps invalid YouTube local STT configuration to an actionable remediation"`

### S3 - CLI option · CLI fixture · ~8k

**C6** - `ingest url --plugin` YouTube com `effects.stt: true` e `--stt` não é `PLUGIN_OPTION_UNSUPPORTED` e encaminha `stt: true`.
Proof: `npx vitest run apps/cli/test/url-ingestion-acceptance.test.ts -t "forwards --stt to a YouTube plugin that declares the local STT effect"`

### S4 - Doctor · plugin healthcheck · ~8k

**C7** - `healthcheck` sem `SHELDON_LOCAL_STT_EXECUTABLE` inclui `id: local-stt`, `severity: warning`, `message: Local STT is optional and no model is downloaded automatically.`, e o check `yt-dlp` permanece o diagnóstico de versão.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "declares its yt-dlp runtime dependency and bounded version healthcheck"`

**C8** - Checks só com warning `local-stt` (sem `error`) não tornam o plugin unhealthy.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "declares its yt-dlp runtime dependency and bounded version healthcheck"`
Proof: `npx vitest run packages/plugin-host/test/doctor.test.ts -t "runs only healthcheck, saves exact health, and keeps warnings healthy"`

## Handoff

S1–S4 = um batch. Mesmo plugin YouTube, host recovery e CLI acceptance; bem abaixo de 150k. Sem handoff.

## Swept

- validation: C5, C6
- failure modes: C2, C3, C5
- idempotency and retry: existing - raw imutável
- authorization: n/a - sem auth/cookies no YouTube
- concurrency and ordering: n/a - um ingest por processo
- data lifecycle: n/a - áudio STT temporário
- external-dependency failure: C3, C4, C7
- state transitions: n/a
- observability: C2, C3, C5, C7

## Coverage

| Set (size)       | Member -> proof                                                                                            | Unproven |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| ingest paths (4) | captioned+stt C1 · uncaptioned no stt C2 · uncaptioned stt unconfigured C3 · uncaptioned stt configured C4 | -        |
| STT config (3)   | unconfigured C3 · invalid C5 · configured C4                                                               | -        |
| CLI --stt (2)    | youtube declares stt C6 · url fixture still rejects existing test                                          | -        |
| doctor (2)       | youtube local-stt warning C7 · warning not unhealthy C8                                                    | -        |

- Claims naming a status code, route or response shape: C2, C3, C5, C6 - each has a proof that crosses the host or CLI boundary
- No other check claims more than the single case its proof exercises
