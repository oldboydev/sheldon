# Issue 49 — yt-dlp stdout maxBuffer

Sources:

- Issue: [#49](https://github.com/oldboydev/sheldon/issues/49)
- Task: `.tasks/issue-49-youtube-ytdlp-maxbuffer.md`

## Out of scope

HTTP 429 (#50), playlists, STT, Git remoto, outros plugins.

## Landing

`source.youtube` declara `maxBuffer` ≥ 32 MiB no `execFile` do yt-dlp e aceita JSON > 1 MiB no runner injetado.

## Checks

### S1 — Extração YouTube · ~20 KB

**C1** — `YT_DLP_STDOUT_MAX_BUFFER_BYTES` ≥ 32 MiB e o `systemRunner` passa esse `maxBuffer` ao `execFile`.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "declares a yt-dlp stdout maxBuffer"`

**C2** — Extração aceita stdout JSON maior que 1 MiB com runner injetado.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "accepts yt-dlp JSON stdout larger than the Node execFile default maxBuffer"`

**C3** — Estouro de `maxBuffer` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) mapeia para `YOUTUBE_RESPONSE_INVALID`.
Proof: `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "maps execFile maxBuffer overflow to YOUTUBE_RESPONSE_INVALID"`

**C4** — A suíte `yt-dlp.test.ts` completa passa (casos de falha real, cancelamento e caminhos).
Proof: `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts`
