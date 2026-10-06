# Restyle sheldon web with the product design system Verification

**Verdict**: PASS
**Profile**: light (no `AGENTS.md`; skipped step 1 ui, Coverage join, Test policy verdicts, fault injection)
**Diff range**: `037123fad4a45a6703ab946802f526555ce1187d`..`454a99abd042eb015ad91dd34fafd2fa6a8615e9`
**HEAD**: `454a99abd042eb015ad91dd34fafd2fa6a8615e9`
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

## Binding sources

Step 1 (checklist vs design, per-screen arrangement coverage) did **not** run — profile is `light`. Sources were opened so checks could be judged against named values.

| Source                                         | Opened           | Contradiction                | Uncovered                    |
| ---------------------------------------------- | ---------------- | ---------------------------- | ---------------------------- |
| `.interface-design/system.md`                  | yes - local file | n/a — step 1 skipped (light) | n/a — step 1 skipped (light) |
| https://github.com/oldboydev/sheldon/issues/39 | yes - issue body | n/a — step 1 skipped (light) | n/a — step 1 skipped (light) |
| `.tasks/web-design-system-restyle.md`          | yes - local file | n/a — step 1 skipped (light) | n/a — step 1 skipped (light) |

## Checks

Proofs batched in one `vitest` invocation at HEAD. Reporter: 23 passed, 18 skipped, 0 failed. Each named test appeared individually as passed.

| Check | Claim                                                                                                            | Proof run                                                                                                                | Evidence                                                                                                                                                                                                                                       | Result |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1    | `--brand-navy: #001663`, `--brand-magenta: #e74092`, Nunito Sans from CLI help TTF, no Bahnschrift, no `#e8e4da` | `styles.test.ts` `-t "defines product tokens…"` exit 0                                                                   | `apps/web/test/styles.test.ts:13` `toMatch(/--brand-navy:\s*#001663/)`; `:14` magenta `#e74092`; `:16` `cli/help/fonts/NunitoSans-VariableFont_YTLC_opsz_wdth_wght.ttf`; `:17` `not.toMatch(/Bahnschrift/i)`; `:18` `not.toContain('#e8e4da')` | PASS   |
| C2    | Wordmark text `Sheldon`; no `stix`, equalizer identity, `--gradient-brand`                                       | `app-shell.test.tsx` `-t "wordmark is the text Sheldon"`; `styles.test.ts` `-t "web chrome has no stix identity"` exit 0 | `apps/web/test/app-shell.test.tsx:45` `toBe('Sheldon')`; `styles.test.ts:23` `not.toContain('stix')`; `:24` `not.toContain('--gradient-brand')`; `:25` `not.toMatch(/\.eq\b/)`                                                                 | PASS   |
| C3    | Titlebar: Sheldon, `dashboard.path`, `neste computador`, Atualizar, theme toggle; full-viewport                  | `app-shell.test.tsx` `-t "titlebar shows Sheldon vault path…"` exit 0                                                    | `apps/web/test/app-shell.test.tsx:55–59` `toContain('Sheldon')`, `toContain('C:\\knowledge\\sheldon')`, `toContain('neste computador')`, `namedButton('Atualizar')`, `[data-theme-toggle]` not null; `:54` `.desktop` is null                  | PASS   |
| C4    | Sidebar groups Bancada/Vault/Entrega/Sistema, seven sections, Revisão count, `navitem is-active`, footer         | `app-shell.test.tsx` `-t "sidebar groups the seven sections…"` exit 0                                                    | `apps/web/test/app-shell.test.tsx:65–78` group labels + seven `namedButton`s; `:76` Revisão `toMatch(/2/)`; `:77` `.navitem.is-active` matches Início; `:78` `somente neste computador`                                                        | PASS   |
| C5    | `max-width: 760px` nav horizontal scroller; titlebar kept                                                        | `styles.test.ts` `-t "mobile breakpoint…"` exit 0                                                                        | `apps/web/test/styles.test.ts:35` `@media (max-width:\s*760px)`; `:37` `nav[\s\S]{0,400}overflow:\s*auto`; `:38` titlebar not `display: none`                                                                                                  | PASS   |
| C6    | Início title, four tiles bind jobs/health, provenance rail, Nova fonte → Fontes                                  | `app-shell.test.tsx` `-t "inicio tiles bind dashboard…"` exit 0                                                          | `apps/web/test/app-shell.test.tsx:84` `Fila e saúde do vault.`; `:85–88` `2`/`1`/`3`/`íntegro`; `:89` `raw\s*→\s*proposta\s*→\s*conceito`; `:91` active nav Fontes                                                                             | PASS   |
| C7    | Fontes chips OCR/STT/rede from probe; one primary CTA                                                            | `app-shell.test.tsx` `-t "fontes renders ocr stt rede…"` exit 0                                                          | `apps/web/test/app-shell.test.tsx:100` `primaries.length).toBe(1)`; `:111–114` `OCR`/`STT`/`rede`; `:114` `.chip` count ≥ 3                                                                                                                    | PASS   |
| C8    | Bundles JSON hidden until preview                                                                                | `app-shell.test.tsx` `-t "bundles hides json until preview"` exit 0                                                      | `apps/web/test/app-shell.test.tsx:128` `not.toContain('"bundleId"')` after create; `:130` `toContain('"bundleId"')` after `Ver prévia`                                                                                                         | PASS   |
| C9    | Conhecimento lists topics/projects, wiki HTML, in-wiki links, sources/neighbours, empty copy, tree 260px         | five `knowledge-view.test.tsx` names + `styles.test.ts` tree 260px; all exit 0                                           | `knowledge-view.test.tsx:81–83` Memory / Sheldon App / path order; `:92–94` exact empty copy; `:119–120` relative link body; `:153–155` raw source text; `:172–176` outgoing/incoming; `styles.test.ts:43` `grid-template-columns:\s*260px`    | PASS   |
| C10   | Pending list per topic; selects not the only picker; open uses GET topic/slug/id; empty copy                     | `review-view.test.tsx` list+open and empty-state; exit 0                                                                 | `review-view.test.tsx:74–77` topic + proposal id, `select[name="topic"]` length 0; `:80–82` nested preview files; `:100` `/nenhuma proposta pendente/i`                                                                                        | PASS   |
| C11   | Approve/reject POST `confirmation` = proposal id + paths/reason; id visible; diff in a card                      | `review-view.test.tsx` approve + reject; exit 0                                                                          | `review-view.test.tsx:149–155` POST `/approve` body `{ confirmation, paths }`; `:170–176` POST `/reject` body `{ confirmation, reason }`; `:147` proposal id in text                                                                           | PASS   |
| C12   | No M7/emoji; `[data-theme="dark"]`; reduced-motion; loopback 421                                                 | app-shell + styles + server named proofs; exit 0                                                                         | `app-shell.test.tsx:136` `not.toContain('M7')`; `:137` no emoji range; `:143` `data-theme` `dark`; `styles.test.ts:48` `prefers-reduced-motion:\s*reduce`; `server.test.ts:43–44` 421 + `WEB_LOCAL_ORIGIN_REQUIRED`                            | PASS   |
| C13   | `GET /api/v1/dashboard` `path` = vault root; health/jobs remain                                                  | `server.test.ts` `-t "dashboard includes the vault path"` exit 0                                                         | `apps/web/test/server.test.ts:81–86` `statusCode` 200 and `toMatchObject({ path: root, health, jobs })`                                                                                                                                        | PASS   |

### Assertion notes (not FAIL)

- **C3** full-viewport is settled by `.desktop` absent plus class `.win`. The class name is leftover; CSS at `apps/web/src/styles.css:157–162` is `min-height: 100vh`. The test does not assert `100vh`.
- **C4** grouping is `textContent` of labels, not a DOM parent/child assertion. Implementation groups via `navGroups` in `App.tsx`.
- **C6** job counts are bare digit presence (`2`/`1`/`3`), not tile-scoped. Pending review count is also `2`.
- **C9** “three cards” is the test title; the assertion is only the 260px first column. Markup in `KnowledgeView.tsx:99–156` is three `.card` regions. `knowledge-view.test.tsx` is **not** in the feature diff; it still ran against changed `KnowledgeView.tsx` at HEAD.
- **C10** empty copy is `/nenhuma proposta pendente/i`, not the named sentence `Nenhuma proposta pendente neste vault.` Implementation has the full sentence (`ReviewView.tsx:122`). Opening does not assert the GET URL; stub only returns preview for `/api/v1/reviews/topic/` (level gap vs `:slug/:proposalId`).
- **C11** `.card, .panel` in the C10 open test is tautological: ReviewView always renders `<div className="panel">` for the job list (`ReviewView.tsx:201`). Diff-in-card is therefore weakly proven. POST bodies settle the write contract. Approve URL is `includes('/approve')`, not the full `/api/v1/reviews/topic/:slug/:proposalId/approve`.
- **C12** reduced-motion proof matches the `@media` rule, not `transition: none`. Implementation sets `transition: none !important` (`styles.css:962–969`).

## Test policy rows

Skipped — profile `light` (no `## Test policy` section judged; Coverage join not recomputed).

## Faults injected

Skipped — profile `light`.

## Swept (existing vs code)

| Row                                                        | Cited constraint                      | In code at HEAD?                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| validation                                                 | `requireConfirmation` / reject reason | yes — `apps/web/src/server.ts:141` and `:154` call `requireConfirmation(body, params.proposalId)`; `:155` `if (!body.reason?.trim()) throw`; helper `:331–347` (`WEB_CONFIRMATION_REQUIRED`). Empty reason is a generic `Error` (no `code`); the handler at `:64–69` then sends **500**, not 400. Confirmation mismatch is 400 (`server.test.ts:155–156`). |
| failure modes                                              | preview and refresh error copy        | yes — preview: `ReviewView.tsx:80–81` and existing test `review-view.test.tsx:86–94`; refresh: `App.tsx:67` + `:143` `.notice.error`                                                                                                                                                                                                                       |
| authorization                                              | `WEB_LOCAL_ORIGIN_REQUIRED` (C12)     | yes — `server.ts:42–54` hook status 421; `server.test.ts:43–44`                                                                                                                                                                                                                                                                                            |
| dependency failure                                         | dashboard refresh error               | yes — `App.tsx:66–68`                                                                                                                                                                                                                                                                                                                                      |
| state transitions                                          | C11                                   | yes — proven by C11 POST bodies                                                                                                                                                                                                                                                                                                                            |
| idempotency / concurrency / data lifecycle / observability | n/a                                   | n/a — no code to contradict                                                                                                                                                                                                                                                                                                                                |

## Gate

```
npx vitest run apps/web/test/styles.test.ts apps/web/test/app-shell.test.tsx apps/web/test/knowledge-view.test.tsx apps/web/test/review-view.test.tsx apps/web/test/server.test.ts -t "<23 named proofs>" --reporter=verbose
```

23 passed, 18 skipped, 0 failed (v4.1.10) at `454a99abd042eb015ad91dd34fafd2fa6a8615e9`.
