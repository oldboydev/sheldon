<!-- markdownlint-disable MD029 MD034 MD060 -->

# Restyle sheldon web with the product design system

> Build this with **tlc-implement**.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

`sheldon web` already covers the seven PRD 009 areas, but the chrome is a one-off: charcoal
sidebar, gold “S” disc, Bahnschrift 63px titles, parchment `#e8e4da`, teal primary, and an
internal “VAULT LOCAL / M7” header. Anyone opening the loopback UI pays with a product that
does not match the tokens already used by CLI HTML help (`apps/cli/help/styles.css`, Nunito
Sans, navy `#001663`, magenta `#e74092`). The issue gives no volume figure.

When this ships, the local web app is a full-viewport bench with navy 48px titlebar, 232px
light sidebar grouped Bancada/Vault/Entrega/Sistema, magenta primary actions, and the seven
existing sections bound to the same APIs. Wordmark is the text **Sheldon**. Binding design:
`.interface-design/system.md`.

13 criteria in 6 slices · 3 one-way doors · 2 open, of which 0 block

Sizing evidence: CONTRIBUTING does not declare task size; GitHub issue #39 is one enhancement;
default is one task. The slices share `apps/web/src/App.tsx` and `styles.css`.

## Criteria

### Tokens e identidade

1. Always, `apps/web` CSS defines `--brand-navy: #001663` and `--brand-magenta: #e74092`,
   loads Nunito Sans from `apps/cli/help/fonts/NunitoSans-VariableFont_YTLC_opsz_wdth_wght.ttf`,
   and does not use Bahnschrift or parchment `#e8e4da`.
2. Always, the chrome wordmark is the text `Sheldon`. `apps/web` source has no `stix` string,
   no equalizer identity markup, and no `--gradient-brand` as product identity.

### Shell

3. When the app renders with a dashboard, the titlebar shows `Sheldon`, `dashboard.path`, the
   pill `neste computador`, **Atualizar**, and a theme toggle. The shell is full-viewport (no
   fake Electron window or navy wallpaper).
4. When the app renders, the sidebar groups **Bancada** (Início, Fontes), **Vault**
   (Conhecimento, Revisão with the pending-proposal count, Consulta), **Entrega** (Bundles),
   **Sistema** (Configurações). The footer reads `somente neste computador`. The active item
   has class `navitem is-active`.
5. Always, at `max-width: 760px` the CSS makes the sidebar nav a horizontal scroller and keeps
   the titlebar.

### Início

6. When Início is shown, the screen title is `Fila e saúde do vault.`, four tiles bind
   `dashboard.jobs.queued`, `dashboard.jobs.running`, `dashboard.jobs.failed`, and
   `dashboard.health.vault`, the provenance rail is `raw → proposta → conceito`, and the
   magenta CTA **Nova fonte** opens Fontes.

### Fontes, Consulta, Bundles, Configurações

7. Given a Fontes probe that returns `effects.ocr`, `effects.stt`, and `permissions.network`,
   when the probe succeeds, then those flags render as chips `OCR`, `STT`, and `rede`. Fontes,
   Consulta, and Configurações keep their existing POST/GET flows and each screen has one
   primary CTA.
8. When Bundles creates a definition, the JSON body is not shown until the user requests
   preview.

### Conhecimento

9. Given the existing wiki API, when the user opens Conhecimento, then topics and projects
   list, wiki HTML opens, in-wiki links resolve, and sources/neighbours show. Empty copy stays
   `Nenhum tópico ainda. Crie um tópico antes de ingerir uma fonte.` Layout is three cards;
   the tree column is `260px`.

### Revisão

10. Given `GET /api/v1/reviews` returns topics with pending proposals, when Revisão opens,
    then those proposals are listed per topic (topic title and proposal id). The two
    `<select>`s are not the only picker. Opening a proposal uses
    `GET /api/v1/reviews/topic/:slug/:proposalId`. Given no pending topics, the copy is
    `Nenhuma proposta pendente neste vault.`
11. Given an open preview, when the user approves, then the client POSTs
    `/api/v1/reviews/topic/:slug/:proposalId/approve` with `confirmation` equal to the
    proposal id and the preview paths. When the user rejects with a reason, then the client
    POSTs `.../reject` with `confirmation` equal to the proposal id and that reason. The
    proposal id is visible in the confirmation UI. Diff text sits in a card.

### Copy, tema, loopback

12. Always, the chrome has no `M7` and no emoji. Dark theme is applied with
    `[data-theme="dark"]` on the document element. `prefers-reduced-motion` disables
    transitions. Loopback still returns 421 `WEB_LOCAL_ORIGIN_REQUIRED`.
13. Always, `GET /api/v1/dashboard` includes `path` equal to the vault root the server
    opened, and existing dashboard `health` / `jobs` fields remain.

## Out of scope

- Stix logo, equalizer bars, `--gradient-brand` identity, PRD/QA env badges, window
  controls, avatar — issue #39
- Restyling `sheldon help --html` — already on these tokens
- New domain rules in the web app — API remains the source of truth except the additive
  `dashboard.path` display field
- Visual Markdown editor, graph, vault HTML export, multi-vault switcher, public UI
- Filling the job list from CLI compile
- Shipping a desktop (Electron) shell
- Rewriting plugins or the catalog

## Observable

| Surface                                | Decision                    | Landing                                                      |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------ |
| screen shell                           | empty                       | n/a - chrome always renders; vault data empty is per-section |
| screen shell                           | loading                     | existing - 3s refresh already covers in-flight               |
| screen shell                           | error                       | existing - `.notice.error` on refresh failure                |
| screen shell                           | unauthorised                | existing - loopback 421                                      |
| screen Início                          | empty jobs                  | existing - `Ainda não há trabalhos registrados.`             |
| screen Fontes                          | error                       | existing - probe/upload error message                        |
| screen Conhecimento                    | empty                       | 9                                                            |
| screen Conhecimento                    | error                       | existing - `ApiProblem` `code` + `message` + `recovery`      |
| screen Revisão                         | empty                       | 10                                                           |
| screen Revisão                         | error                       | existing - preview API `message`                             |
| screen Revisão                         | destructive action confirms | 11                                                           |
| API `GET /api/v1/dashboard`            | response shape              | 13                                                           |
| API review GET/POST                    | error shape and codes       | existing - `requireConfirmation` 400                         |
| document `.interface-design/system.md` | structure                   | existing - already the binding brief; lands in this PR       |

## Swept

- validation: existing - review confirmation and reject reason already 400
- failure modes: existing - preview and refresh error copy
- idempotency and retry: n/a - restyle does not change writes
- authorization: existing - `WEB_LOCAL_ORIGIN_REQUIRED` / 421
- concurrency and ordering: n/a - no new concurrent writes
- data lifecycle: n/a - no stored UI state except optional theme key
- external-dependency failure: existing - dashboard refresh error
- state transitions: 11
- observability: n/a - no new log/metric requirement

## Impact

| Front       | What changes                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| domain      | no new term                                                                                           |
| domain      | existing term: chrome wordmark meant gold “S” + `SHELDON`, now means text `Sheldon` — `App.tsx`       |
| stored data | nothing to migrate; additive `path` on dashboard JSON; existing `toMatchObject` callers keep matching |

## Decided

| Decision               | Shape                                                                                                                                | Alternative rejected                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Token names            | Reuse CLI help / pack names `--brand-navy`, `--brand-magenta`, `--ink`, `--bg`, `--card`, `--line`, `--focus-ring` in `apps/web` CSS | A second palette (`--gray-700`) — would fork the product tokens already in `apps/cli/help/styles.css`                                   |
| Dark theme             | `[data-theme="dark"]` on `document.documentElement`; default light; toggle does not key the default on `prefers-color-scheme`        | `prefers-color-scheme` as the only switch — the pack and the issue name the data attribute                                              |
| Vault path in titlebar | `GET /api/v1/dashboard` gains `path: string` (absolute vault root the server already has)                                            | Injecting the path into `index.html` at listen time — Vite/jsdom would not see it; a new endpoint — dashboard is already the read model |

## Sources

- https://github.com/oldboydev/sheldon/issues/39 - recorte, testes, fora de escopo
- `.interface-design/system.md` - **binding for the interface**: shell, Início, Fontes,
  Conhecimento, Revisão, tokens, copy
- `docs/prds/009-local-web-interface.md` - seven areas; UI consumes the local API
- `apps/cli/help/styles.css` + `apps/cli/help/fonts/` - token names and Nunito Sans file

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question                                                                                                               | Until answered                                                           |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | open | Pixel-perfect visual check of overlap/unreadable text at desktop and ≤760px in a real browser (repo has no Playwright) | jsdom + CSS media-query assertions; manual browser pass when tools exist |
| 2   | open | Persist theme across reloads?                                                                                          | `localStorage` key `sheldon-web-theme` (`dark` or absent); reversible    |
