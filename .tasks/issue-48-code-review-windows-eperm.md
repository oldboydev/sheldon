<!-- markdownlint-disable MD029 MD034 MD060 -->

# Issue 48 — revisão local sai com erro quando a limpeza da pasta temporária falha

> Build this with **tlc-implement**, profile light.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

No Windows, quando outro processo segura a pasta temporária da cópia isolada
(`%TEMP%\codex-code-review-*`) na hora da limpeza, `npm run review:run` sai com
código 1 e `Code review interrompido: EPERM, Permission denied: …` depois de uma
revisão que fechou `ready`. O relatório já estava validado e gravado no estado, e
o comando não o imprime. Quem lê a saída entende que a revisão falhou. A trava da
issue já é liberada nesse caso, desde a adoção da revisão local (#46). Conferido
em `scripts/code-review/review.mjs` (`review` `finally` chama `deps.cleanup` e
relança) e no C10 actual, que espera `review()` rejeitar com `/EPERM cleanup/`.
A issue não dá volume.

O resultado de uma revisão concluída deixa de ser trocado pelo erro da limpeza:
o comando imprime o relatório e sai com o código do status dele. Se a própria
revisão falhou, o erro que sai é o dela. A pasta que sobrar é avisada no stderr,
com o caminho. A cópia do motor volta a ser idêntica à do ERP.

7 criteria in 5 slices · 1 one-way door · 0 open, of which 0 block

Sizing evidence: CONTRIBUTING does not declare task size; GitHub issue #48 is one
bug; default is one task.

## Criteria

### Resultado da revisão quando a limpeza falha

1. Dado a revisão concluída e o relatório validado, quando a limpeza da pasta
   temporária falha, então o comando `cli.mjs review` imprime o relatório no
   stdout e sai com 0 para `ready` e com 2 para os outros status.
2. Dado a revisão falha e a limpeza falha, quando o comando termina, então
   escreve `Code review interrompido: ` seguido do erro da revisão, e sai com 1.

### Aviso da pasta que sobrou

3. Quando a pasta temporária sobra, então o aviso no stderr inclui o caminho.
   Quando a pasta não sobra, nenhum aviso é escrito.

### Trava libertada

4. Sempre, a trava da issue não existe ao fim do processo nos casos acima.

### Identidade com o ERP

5. Sempre, `scripts/code-review/review.mjs`, `review.test.mjs` e `README.md`
   ficam com os blobs Git `c51cff675f6472b9e2ffa02eaa03cd80f3d48dad`,
   `6495b4d3d61db91c5896e7efc919880237f4b572` e
   `711a7161c58ea65dd8dd6a6148d8ef3948d4f2eb`, os mesmos do ERP em `781ca4c`.
   `cli.mjs` e `schema.json` continuam em
   `c6a4abcd52cf140f64b596136080f36d066b1ee8` e
   `b02001e2b10df2e46b244490ee3cf5ae1b410694`.
6. Sempre, `npm run test:code-review` passa neste repositório com 16 casos, sem
   falha e sem caso pulado, incluídos os quatro `C10` e os três `C11`.

### Limite

7. Sempre, os workflows de CI, de release e de publicação no npm, a
   configuração da revisão (`code-review.config.json`) e o código de produto
   não mudam.

## Out of scope

- Adaptar o motor neste repositório — a correção é a do ERP, sem adaptação.
- Mudar `cli.mjs` ou `schema.json` — issue #48.
- Workflows de CI, release e publicação no npm — issue #48.
- `code-review.config.json` e código de produto (`apps/`, `packages/`) — issue #48.
- Publicar npm 0.2.12.
- Issues #57 e #59 (fechadas).

## Observable

| Surface                          | Decision                         | Landing                                      |
| -------------------------------- | -------------------------------- | -------------------------------------------- |
| command `cli.mjs review`         | stdout JSON do relatório         | 1                                            |
| command `cli.mjs review`         | exit 0 `ready`, 2 outros status  | 1                                            |
| command `cli.mjs review`         | error shape e exit 1             | 2 — `Code review interrompido: ` no stderr   |
| command `cli.mjs review`         | flags e omissão                  | existing - `--issue`, `--profile`            |
| command `cli.mjs review`         | verbosity do aviso de leftover   | 3                                            |
| document `scripts/code-review/README.md` | copy leftover TEMP         | 3, 5                                         |
| collection cinco arquivos comuns | hashes Git                       | 5, 6                                         |

## Swept

- validation: n/a - sem flags nem input novos
- failure modes: 1, 2
- idempotency and retry: existing - mesma identidade reutiliza o relatório (C10 ready)
- authorization: n/a - comando local
- concurrency and ordering: 4 - lock sempre libertado
- data lifecycle: 3 - pasta leftover avisada para apagar à mão
- external-dependency failure: 1, 3 - EPERM do SO/git na limpeza
- state transitions: 4 - lock some; status da revisão não muda
- observability: 3 - aviso no stderr com o caminho

## Impact

| Front       | What changes                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| domain      | existing term: falha de limpeza no `finally` de `review()` deixa de substituir o relatório, ou o erro da revisão, pelo da limpeza — `cli.mjs` hoje trata o throw como `Code review interrompido` e exit 1 |
| stored data | nothing to migrate — leftover TEMP fica no disco até apagar à mão; lock continua a ser desligado |

## Decided

| Decision                                      | Shape                                                                                                                                                         | Alternative rejected                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Copiar o motor do ERP sem adaptação           | blobs Git `c51cff6…` / `6495b4d…` / `711a716…` em `review.mjs`, `review.test.mjs`, `README.md`; `cli.mjs` e `schema.json` inalterados                          | adaptar o motor neste repositório — a issue exige igualdade dos cinco arquivos entre os consumidores          |

## Surface

| Route             | In                     | Out                                                                 | Status                         | Criteria |
| ----------------- | ---------------------- | ------------------------------------------------------------------- | ------------------------------ | -------- |
| `cli.mjs review`  | `--issue`, `--profile` | JSON do relatório no stdout; aviso de leftover no stderr            | exit 0 `ready`, 2 outros, 1 erro | 1, 2, 3, 4 |

## Sources

- https://github.com/oldboydev/sheldon/issues/48 - comportamento, critérios, blobs, fora de escopo
- oldboydev/3dprintingerp#249 merge `781ca4c` - origem dos três arquivos
- Conversação 2026-10-26 - «pode fazer a proxima raia»; uma entrega, um PR, só
  #48; sem push até o proprietário pedir

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question | Until answered |
| --- | ---- | -------- | -------------- |
|     |      | None     |                |
