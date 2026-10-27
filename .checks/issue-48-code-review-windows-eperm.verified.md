<!-- markdownlint-disable MD034 MD060 -->

# Issue 48 — revisão local sai com erro quando a limpeza da pasta temporária falha Verification

**Verdict**: PASS
**Profile**: light (`AGENTS.md` tlc-implement profile light, handoff on)
**Diff range**: `70798b5c9e7049dce46aa4de1168ee9b98f03276`..`05654840317d65b1cb31ae97857c89d4cf55e86b` (`origin/main`..`HEAD`)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

Author of `0565484` is `pm@oldboy.dev`. Verifier did not implement `review()` `finally` leftover handling, C10/C11 tests, or docs. No production code, tests, checklist, or task were edited. Only this file was written.

PATH prepended: `C:\nvm4w\nodejs` (node v24.22.1). Named C10/C11 proofs re-run filtered at HEAD `0565484`; C6 re-run as the full unfiltered suite. Each named test exists (`rg`) and appeared individually as `✔` (not `passWithNoTests`).

Skipped under **light** (not forgotten): Binding sources step 1 screen/arrangement (ui), Coverage join as required table, Test policy rows, fault injection.

## Binding sources

verified at `0565484` (issue + task + checklist). Step 1 skipped — profile light.

| Source                                                                    | Opened                                            | Contradiction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Uncovered                      |
| ------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [issue #48](https://github.com/oldboydev/sheldon/issues/48) (**binding**) | yes — `gh issue view 48 --repo oldboydev/sheldon` | none. Open issue. Criteria match C1–C7: concluded review is not replaced by cleanup failure (stdout report, exit 0 `ready` / 2 other status); review failure with cleanup failure writes `Code review interrompido:` then a space then the review error and exit 1; leftover TEMP warned on stderr with path, no warning when gone; lock gone at end; five Git blobs; 16 tests with four C10 and three C11; CI/release/npm, `code-review.config.json`, and product do not change. Out of scope is listed, not checked. | Step 1 skipped — profile light |
| `.tasks/issue-48-code-review-windows-eperm.md` criteria 1–7               | yes                                               | none. Checklist C1–C7 are the task criteria 1–7. Landing’s ERP byte-copy of three files (no local adaptation) is the decided one-way door, not a new criterion.                                                                                                                                                                                                                                                                                                                                                        | Step 1 skipped — profile light |
| `.checks/issue-48-code-review-windows-eperm.md`                           | yes                                               | n/a — the checklist is the contract under verification. Proofs named in C1–C7 are the commands run below.                                                                                                                                                                                                                                                                                                                                                                                                              | Step 1 skipped — profile light |

## Checks

Named tests exist (`rg`) at HEAD `0565484` in `scripts/code-review/review.test.mjs`:

- `:142` `test("C10 falha de limpeza devolve o relatório ready, libera lock e preserva aprovação e contador"`
- `:177` `test("C10 falha de limpeza devolve o relatório changes_requested e avisa a pasta no stderr"` (C6 fourth C10; not a C1–C4 named proof)
- `:211` `test("C10 falha de limpeza que não deixa a pasta devolve o relatório e não avisa"`
- `:228` `test("C10 revisão falha seguida de falha de limpeza mostra o erro da revisão e libera lock"`
- `:339` template `C11 comando com limpeza falha imprime o relatório ${status}, sai com ${code} e avisa a pasta no stderr` for status `ready` (exit 0) and `changes_requested` (exit 2)
- `:365` `test("C11 comando com revisão falha e limpeza falha escreve o erro da revisão e sai com 1"`

Checklist proof strings are prefixes of those titles. All six named C1–C4 tests live in this feature diff (`0565484`), not in an untouched suite.

| Check | Claim                                                                                                                                                                                                                                                                                                              | Proof run                                                                                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Result |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| C1    | Dado a revisão concluída e o relatório validado, quando a limpeza da pasta temporária falha, então `cli.mjs review` imprime o relatório no stdout e sai com 0 para `ready` e com 2 para os outros status.                                                                                                          | filtered `node --test` at `0565484` — both named C11 proofs passed (`ready` 3042ms / `changes_requested` 3070ms). Also ✔ in C6 unfiltered.                                                  | Loop `:335-338` `["ready", 0]` / `["changes_requested", 2]`. `:349` `assert.equal(state.attempts[0].report.status, status)`; `:350-353` `assert.equal(run.stdout, JSON.stringify(state.attempts[0].report, null, 2) + "\n")`; `:354` `assert.equal(run.status, code)`. Production: `scripts/code-review/cli.mjs:7-9` `process.stdout.write(JSON.stringify(report, null, 2) + "\n")` then `if (report.status !== "ready") process.exitCode = 2`. Cleanup throw is swallowed in `review()` `finally` (`review.mjs:727-735`), so `cli.mjs` still receives the report. | PASS   |
| C2    | Dado a revisão falha e a limpeza falha, quando o comando termina, então escreve `Code review interrompido:` seguido de espaço e do erro da revisão, e sai com 1.                                                                                                                                                   | filtered `node --test` at `0565484` — `C11 comando com revisão falha e limpeza falha` pass 2367ms. Also ✔ in C6.                                                                            | `:369` `assert.equal(run.stdout, "")`; `:370-373` assert.equal(run.stderr, leftoverWarning(run.checkout) plus newline plus "Code review interrompido: falha de revisão" plus newline); `:374` `assert.equal(run.status, 1)`. The interrupt line is the prefix `Code review interrompido:` then a space then `falha de revisão`. Production `cli.mjs:16-18` writes that prefix, a space, and `error.message`, then sets `process.exitCode = 1`. `review()` rethrows the review error, not cleanup (`review.mjs:726-735` catch does not rethrow).                    | PASS   |
| C3    | Quando a pasta temporária sobra, então o aviso no stderr inclui o caminho. Quando a pasta não sobra, nenhum aviso é escrito.                                                                                                                                                                                       | filtered `node --test` at `0565484` — C10 leftover-ready 4399ms / C10 no-leftover 2598ms. Also ✔ in C6.                                                                                     | Helper `:138-139` `leftoverWarning(checkout)` embeds `${checkout}`. Leftover: `:162` `assert.deepEqual(warnings, [leftoverWarning(checkout)])`. No leftover: `:223` `assert.equal(existsSync(f.locations[0]), false)`; `:224` `assert.deepEqual(warnings, [])`. Production `review.mjs:732-735`: `if (existsSync(checkout))` then `deps.warn` with the checkout path and `error.message` in the warning. Default `warn` writes stderr (`:381`).                                                                                                                    | PASS   |
| C4    | Sempre, a trava da issue não existe ao fim do processo nos casos acima.                                                                                                                                                                                                                                            | filtered `node --test` at `0565484` — four named proofs: C10 ready 4399ms, C10 review+cleanup fail 2529ms, C11 ready 3042ms, C11 review+cleanup fail 2367ms. Also ✔ in C6.                  | C10 ready `:157-160` `assert.equal(existsSync(join(f.cwd, ".git/code-review/issue-7.lock")), false)`. C10 review fail `:247-250` same `existsSync(…issue-7.lock) === false`. C11 ready `:356-358` same. C11 fail `:375-377` same. Production: `review.mjs:736-740` inner `finally` `closeSync(lock)` then `unlinkSync(p.lock)` after cleanup’s catch, so the lock is released whether cleanup throws or not.                                                                                                                                                       | PASS   |
| C5    | Sempre, `review.mjs` / `review.test.mjs` / `README.md` blobs `c51cff675f6472b9e2ffa02eaa03cd80f3d48dad` / `6495b4d3d61db91c5896e7efc919880237f4b572` / `711a7161c58ea65dd8dd6a6148d8ef3948d4f2eb`; `cli.mjs` `c6a4abcd52cf140f64b596136080f36d066b1ee8`; `schema.json` `b02001e2b10df2e46b244490ee3cf5ae1b410694`. | `git hash-object scripts/code-review/review.mjs scripts/code-review/review.test.mjs scripts/code-review/README.md scripts/code-review/cli.mjs scripts/code-review/schema.json` at `0565484` | stdout, in that order: `c51cff675f6472b9e2ffa02eaa03cd80f3d48dad`, `6495b4d3d61db91c5896e7efc919880237f4b572`, `711a7161c58ea65dd8dd6a6148d8ef3948d4f2eb`, `c6a4abcd52cf140f64b596136080f36d066b1ee8`, `b02001e2b10df2e46b244490ee3cf5ae1b410694`. Five hashes equal the checklist expected set.                                                                                                                                                                                                                                                                   | PASS   |
| C6    | Sempre, `npm run test:code-review` passa neste repositório com 16 casos, sem falha e sem caso pulado, incluídos os quatro `C10` e os três `C11`.                                                                                                                                                                   | `npm run test:code-review` at `0565484` (unfiltered)                                                                                                                                        | TAP: `ℹ tests 16` / `ℹ pass 16` / `ℹ fail 0` / `ℹ skipped 0` / `ℹ todo 0`, exit 0, duration 80446ms. Four C10: ready (`:142`), changes_requested (`:177`), no leftover (`:211`), review-then-cleanup fail (`:228`). Three C11: ready (`:339` status `ready`), changes_requested (`:339` status `changes_requested`), review+cleanup fail (`:365`). Each appeared individually as `✔`.                                                                                                                                                                              | PASS   |
| C7    | Sempre, os workflows de CI, de release e de publicação no npm, a configuração da revisão (`code-review.config.json`) e o código de produto não mudam.                                                                                                                                                              | `git diff --name-only origin/main -- .github/workflows code-review.config.json apps packages` at `0565484`                                                                                  | stdout empty (no names). `origin/main` is `70798b5c9e7049dce46aa4de1168ee9b98f03276`. Feature `git diff --stat origin/main` lists only `.checks/issue-48-code-review-windows-eperm.md`, `.tasks/issue-48-code-review-windows-eperm.md`, `CHANGELOG.md`, `README.md`, `scripts/code-review/README.md`, `scripts/code-review/review.mjs`, `scripts/code-review/review.test.mjs`.                                                                                                                                                                                     | PASS   |

Sampling (do not fail): cleanup failure is injected (`throw` in `deps.cleanup`), not a live Windows `EPERM` from a process holding `%TEMP%\codex-code-review-*` — the binding issue says the tests simulate the throw. C1 samples “outros status” as `changes_requested` only; `blocked` is untested, but `cli.mjs:9` uses `report.status !== "ready"`. C11 reaches real `cli.mjs` via a resolve hook that swaps `./review.mjs` for a double calling the real engine with failing `cleanup`.

## Swept (existing rows re-read against code)

n/a rows are policy — not failed. Check-mapped rows (failure modes C1/C2, concurrency C4, data lifecycle C3, dependency failure C1/C3, state transitions C4, observability C3) are proven in the Checks table, not re-litigated here.

| Row           | Cited constraint                                              | Present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| validation    | n/a - sem flags nem input novos                               | n/a — policy. `cli.mjs review` still takes existing `--issue` / `--profile` (C11 spawn `:320-323`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| idempotency   | existing - mesma identidade reutiliza o relatório (C10 ready) | yes — C10 ready `:165` `assert.deepEqual(await review(f.cwd, f.options, deps), report)` then `:166` `assert.equal(f.calls.length, 1)`: second `review()` with the same fingerprint returns the stored report and does not call `execute` again. Production reuse: `review.mjs:684-690` `state.attempts.findLast((a) => a.fingerprint === s.fingerprint)` then `if (matching?.report) { const report = validateReport(matching.report, s); … return report; }`. Return is inside the outer `try`, so the inner `finally` still `unlinkSync(p.lock)` (`:736-740`). Unchanged contract; C10 ready now also covers it under failing cleanup. |
| authorization | n/a - comando local                                           | n/a — policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Coverage

no Coverage recompute — profile light

## Test policy rows

no Test policy section required — profile light

## Faults injected

no faults injected — profile light

## Gate

Named C1–C4 proofs (one filtered `node --test` invocation at HEAD `05654840317d65b1cb31ae97857c89d4cf55e86b`; multiple `--test-name-pattern`; PATH `C:\nvm4w\nodejs`):

```text
node --test --test-name-pattern "C11 comando com limpeza falha imprime o relatório ready" --test-name-pattern "C11 comando com limpeza falha imprime o relatório changes_requested" --test-name-pattern "C11 comando com revisão falha e limpeza falha" --test-name-pattern "C10 falha de limpeza devolve o relatório ready" --test-name-pattern "C10 falha de limpeza que não deixa a pasta" --test-name-pattern "C10 revisão falha seguida de falha de limpeza" scripts/code-review/review.test.mjs
```

6 passed, 0 failed, 0 skipped. Exit 0. Each named proof appeared individually as `✔`:

```text
✔ C10 falha de limpeza devolve o relatório ready, libera lock e preserva aprovação e contador (4399.5144ms)
✔ C10 falha de limpeza que não deixa a pasta devolve o relatório e não avisa (2598.1414ms)
✔ C10 revisão falha seguida de falha de limpeza mostra o erro da revisão e libera lock (2529.9472ms)
✔ C11 comando com limpeza falha imprime o relatório ready, sai com 0 e avisa a pasta no stderr (3042.4964ms)
✔ C11 comando com limpeza falha imprime o relatório changes_requested, sai com 2 e avisa a pasta no stderr (3070.7998ms)
✔ C11 comando com revisão falha e limpeza falha escreve o erro da revisão e sai com 1 (2367.6622ms)
```

C6 full suite at the same HEAD:

```text
npm run test:code-review
```

16 passed, 0 failed, 0 skipped, 0 todo. Exit 0. Includes four C10 and three C11, each `✔`.

C5:

```text
git hash-object scripts/code-review/review.mjs scripts/code-review/review.test.mjs scripts/code-review/README.md scripts/code-review/cli.mjs scripts/code-review/schema.json
```

Five hashes match the checklist. Exit 0.

C7:

```text
git diff --name-only origin/main -- .github/workflows code-review.config.json apps packages
```

Empty stdout. Exit 0.

Residual (do not fail the gate): C1 does not spawn `blocked`; exit 2 for non-`ready` is the `cli.mjs:9` inequality. Leftover warning is simulated via `deps.warn` / child stderr, not a held Windows directory.
