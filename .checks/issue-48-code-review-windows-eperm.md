<!-- markdownlint-disable MD034 MD060 -->

# Issue 48 — revisão local sai com erro quando a limpeza da pasta temporária falha

Sources:

- https://github.com/oldboydev/sheldon/issues/48 - **binding**: relatório e
  exit do `cli.mjs review` preservados quando a limpeza falha; erro da revisão
  preservado; aviso de leftover no stderr; lock libertado; blobs Git dos três
  arquivos iguais ao ERP `781ca4c`; `cli.mjs` e `schema.json` inalterados; 16
  testes com quatro C10 e três C11; CI/release/npm, `code-review.config.json` e
  produto não mudam
- `.tasks/issue-48-code-review-windows-eperm.md` - critérios 1–7

## Out of scope

- Adaptar o motor neste repositório
- Mudar `cli.mjs` ou `schema.json`
- Workflows de CI, release e publicação no npm
- `code-review.config.json` e código de produto
- Publicar npm 0.2.12
- Issues #57 e #59 (fechadas)

## Landing

Cópia byte-a-byte de `scripts/code-review/review.mjs`, `review.test.mjs` e
`README.md` a partir do ERP em `781ca4c`. `cli.mjs` e `schema.json` ficam iguais.
O `finally` de `review()` passa a apanhar a falha de `cleanup`, avisar leftover
via `deps.warn` se a pasta ainda existe, e libertar o lock no `finally` interno.
CHANGELOG Unreleased e README da raiz acompanham a mudança em `scripts/`.

| One-way door                          | Literal shape                                                                                                          | Alternative rejected                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Motor vendorizado idêntico ao do ERP  | blobs `c51cff6…` / `6495b4d…` / `711a716…`; `cli.mjs` `c6a4abc…`; `schema.json` `b02001e…`                             | adaptar o motor neste repositório — a issue exige igualdade dos cinco arquivos entre consumidores    |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Resultado da revisão quando a limpeza falha · review.mjs + review.test.mjs + cli.mjs · ~55 KB · ~14k

**C1** - Dado a revisão concluída e o relatório validado, quando a limpeza da
pasta temporária falha, então o comando `cli.mjs review` imprime o relatório no
stdout e sai com 0 para `ready` e com 2 para os outros status.
Proof: `npm run test:code-review -- --test-name-pattern "C11 comando com limpeza falha imprime o relatório ready"`
Proof: `npm run test:code-review -- --test-name-pattern "C11 comando com limpeza falha imprime o relatório changes_requested"`

**C2** - Dado a revisão falha e a limpeza falha, quando o comando termina, então
escreve `Code review interrompido: ` seguido do erro da revisão, e sai com 1.
Proof: `npm run test:code-review -- --test-name-pattern "C11 comando com revisão falha e limpeza falha"`

### S2 - Aviso da pasta que sobrou · review.mjs + review.test.mjs · ~55 KB · ~14k

**C3** - Quando a pasta temporária sobra, então o aviso no stderr inclui o
caminho. Quando a pasta não sobra, nenhum aviso é escrito.
Proof: `npm run test:code-review -- --test-name-pattern "C10 falha de limpeza devolve o relatório ready"`
Proof: `npm run test:code-review -- --test-name-pattern "C10 falha de limpeza que não deixa a pasta"`

### S3 - Trava libertada · review.mjs + review.test.mjs · ~55 KB · ~14k

**C4** - Sempre, a trava da issue não existe ao fim do processo nos casos acima.
Proof: `npm run test:code-review -- --test-name-pattern "C10 falha de limpeza devolve o relatório ready"`
Proof: `npm run test:code-review -- --test-name-pattern "C10 revisão falha seguida de falha de limpeza"`
Proof: `npm run test:code-review -- --test-name-pattern "C11 comando com limpeza falha imprime o relatório ready"`
Proof: `npm run test:code-review -- --test-name-pattern "C11 comando com revisão falha e limpeza falha"`

### S4 - Identidade com o ERP · review.mjs + review.test.mjs + README.md · ~64 KB · ~16k

**C5** - Sempre, `scripts/code-review/review.mjs`, `review.test.mjs` e
`README.md` ficam com os blobs Git `c51cff675f6472b9e2ffa02eaa03cd80f3d48dad`,
`6495b4d3d61db91c5896e7efc919880237f4b572` e
`711a7161c58ea65dd8dd6a6148d8ef3948d4f2eb`. `cli.mjs` e `schema.json` continuam
em `c6a4abcd52cf140f64b596136080f36d066b1ee8` e
`b02001e2b10df2e46b244490ee3cf5ae1b410694`.
Proof: `git hash-object scripts/code-review/review.mjs scripts/code-review/review.test.mjs scripts/code-review/README.md scripts/code-review/cli.mjs scripts/code-review/schema.json`

**C6** - Sempre, `npm run test:code-review` passa neste repositório com 16 casos,
sem falha e sem caso pulado, incluídos os quatro `C10` e os três `C11`.
Proof: `npm run test:code-review`

### S5 - Limite · workflows + config + produto · n/a · ~1k

**C7** - Sempre, os workflows de CI, de release e de publicação no npm, a
configuração da revisão (`code-review.config.json`) e o código de produto não
mudam.
Proof: `git diff --name-only origin/main -- .github/workflows code-review.config.json apps packages`

## Handoff

S1–S5 = um batch (~16k). Mesmos três arquivos do motor, provas em
`npm run test:code-review` e hashes Git. Sem handoff.

## Swept

- validation: n/a - sem flags nem input novos
- failure modes: C1, C2
- idempotency: existing - mesma identidade reutiliza o relatório (C10 ready)
- authorization: n/a - comando local
- concurrency: C4 - lock libertado
- data lifecycle: C3 - leftover TEMP avisado
- dependency failure: C1, C3
- state transitions: C4
- observability: C3
