# Issue 50 — YouTube caption HTTP 429

Sources:

- Issue: [#50](https://github.com/oldboydev/sheldon/issues/50)
- Task: `.tasks/issue-50-youtube-caption-rate-limit.md`

## Out of scope

maxBuffer (#49), playlists, Git remoto, outros conectores.

## Landing

429 vira `YOUTUBE_RATE_LIMITED`; passe combinado tenta cada língua; `--stt` segue o fallback.

Passe com JSON válido e 429 nas legendas devolve extração parcial (`rateLimited: true`) para o STT reutilizar o `infoJson`. Alternativa rejeitada: `infoJson` vazio no catch do plugin.

O passe que tomou 429 tenta cada língua mesmo se o outro kind já devolveu ficheiros. VTT sem fala + 429 falha `YOUTUBE_RATE_LIMITED`. Catch STT sem JSON do yt-dlp grava `{ id, webpage_url }` para o `sourceId` não colidir.

## Checks

### S1 — Rate limit de legendas · ~40 KB

**C1** — Passe combinado 429 tenta cada língua e devolve legendas úteis.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "retries each requested language when the combined caption pass is rate-limited"`

**C2** — Sem legendas, extract falha `YOUTUBE_RATE_LIMITED`.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited"`

**C3** — Ingest sem `--stt` propaga `YOUTUBE_RATE_LIMITED`.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "reports rate-limited captions with YOUTUBE_RATE_LIMITED"`

**C4** — Ingest com `--stt` válido segue STT após 429.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/plugin.test.ts -t "falls back to local STT when caption extraction is rate-limited"`

**C5** — Host mapeia `YOUTUBE_RATE_LIMITED` com recuperação de esperar e repetir.
Proof: `npx vitest run packages/plugin-host/test/process-runner-url-diagnostics.test.ts -t "maps YouTube caption rate limits"`
