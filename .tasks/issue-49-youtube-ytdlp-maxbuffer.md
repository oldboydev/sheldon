# Issue 49 — yt-dlp stdout maxBuffer

> Implementar com tlc-implement, profile light. Escopo autorizado: “criar a issue uma para cada problema, planeje e implemente, abra o pr e merge, publica e dist”.

## Intent

O `execFile` de `source.youtube` deixa de cortar o JSON do `yt-dlp --print-json` no teto padrão de 1 MiB do Node.

## Criteria

1. `execFile` da extração YouTube usa `maxBuffer` ≥ 32 MiB.
2. Teste com stdout JSON > 1 MiB (runner injetado) conclui a extração.
3. `YOUTUBE_EXTRACTION_FAILED` continua só para falha real do yt-dlp.
4. Sem playlist/canal, STT, Git remoto ou outros plugins.

## Out of scope

HTTP 429 (#50), playlists, STT, Instagram, publicação npm (depois do merge).

## Observable

| Surface     | Decision                             | Landing |
| ----------- | ------------------------------------ | ------- |
| yt-dlp.ts   | Constante ≥ 32 MiB no `systemRunner` | 1, 3    |
| yt-dlp.test | Stdout > 1 MiB e constante visível   | 2       |

## Decided

Teto 32 MiB (vídeo `0EfloBtfVRk` mediu ~11 MiB). Mesma branch que #50; PR único fecha as duas.

## Sources

- Issue: [#49](https://github.com/oldboydev/sheldon/issues/49)
- Conversação: ingest `https://www.youtube.com/watch?v=0EfloBtfVRk` tópico `3dprinting`.
