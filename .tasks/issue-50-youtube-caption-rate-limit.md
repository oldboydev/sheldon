# Issue 50 — YouTube caption HTTP 429

> Implementar com tlc-implement, profile light. Escopo autorizado na mesma conversa que #49.

## Intent

429 nas legendas deixa de ser `YOUTUBE_EXTRACTION_FAILED`. O plugin tenta cada língua pedida em separado e, sem legendas, falha `YOUTUBE_RATE_LIMITED` ou segue STT se `--stt`.

## Criteria

1. HTTP 429 mapeia para `YOUTUBE_RATE_LIMITED` no plugin e no host, com recuperação de esperar e repetir.
2. Passe combinado com 429 tenta cada língua e publica as legendas obtidas.
3. Sem legendas e sem `--stt`, ingest falha `YOUTUBE_RATE_LIMITED`.
4. Com `--stt` e runtime válido, 429 segue o fallback STT.
5. Testes sem rede.
6. Sem playlist/canal, Git remoto ou outros conectores.

## Out of scope

maxBuffer (#49), playlists, Git remoto, Instagram.

## Observable

| Surface             | Decision                      | Landing |
| ------------------- | ----------------------------- | ------- |
| yt-dlp.ts           | Detecta 429, retry por língua | 1, 2    |
| plugin.ts           | STT se 429 e `--stt`          | 3, 4    |
| process-runner      | Código e recovery no host     | 1       |
| testes youtube/host | Runner injetado, sem rede     | 5       |

## Decided

PR separado de #49. Sem retry com sleep (os testes são síncronos); só fallback por língua. Passe com JSON válido e 429 nas legendas devolve extração parcial (`rateLimited: true`) para o `--stt` reutilizar o `infoJson`; só lança `YOUTUBE_RATE_LIMITED` quando nenhum passe conclui.

## Sources

- Issue: [#50](https://github.com/oldboydev/sheldon/issues/50)
- `INSTAGRAM_RATE_LIMITED` como precedente de diagnóstico.
