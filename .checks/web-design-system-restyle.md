<!-- markdownlint-disable MD034 MD060 -->

# Restyle sheldon web with the product design system

Sources:

- https://github.com/oldboydev/sheldon/issues/39 - recorte, testes, fora de escopo
- `.tasks/web-design-system-restyle.md` - criteria 1–13, doors, sweep
- `.interface-design/system.md` - **binding for the interface**: shell, Início, Fontes,
  Conhecimento, Revisão, tokens, copy
- `docs/prds/009-local-web-interface.md` - seven areas; API remains the source of truth

Profile: `light` (no `AGENTS.md` declaration). This feature has a UI; the floor does not
enumerate designed screens. Raise to `ui` to add that. Handoff: six slices, one batch
(S1–S6 share `App.tsx` + `styles.css`, ~90k).

## Out of scope

- Stix logo, equalizer, `--gradient-brand` identity, env badges, window controls, avatar
- Restyling `sheldon help --html`
- New domain rules besides additive `dashboard.path`
- Visual Markdown editor, graph, vault HTML export, multi-vault, public UI
- Filling the job list from CLI compile
- Electron shell
- Rewriting plugins or the catalog

## Landing

Restyle `apps/web` chrome and screens in place. Keep KnowledgeView/ReviewView API contracts.
Serve Nunito Sans from the existing CLI help font file. Add `path` on dashboard JSON.

| One-way door | Literal shape                                                                                                                               | Alternative rejected                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Token names  | `--brand-navy` `#001663`, `--brand-magenta` `#e74092`, `--ink` / `--bg` / `--card` / `--line` / `--focus-ring` in `apps/web/src/styles.css` | a second palette                          |
| Dark theme   | `[data-theme="dark"]` on `document.documentElement`; default light                                                                          | `prefers-color-scheme` as the only switch |
| Vault path   | `GET /api/v1/dashboard` includes `path` (absolute vault root)                                                                               | inject into `index.html` at listen time   |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Tokens e identidade · styles.css + App.tsx · ~20k

**C1** - `apps/web` CSS defines `--brand-navy: #001663` and `--brand-magenta: #e74092`,
loads Nunito Sans from `apps/cli/help/fonts/NunitoSans-VariableFont_YTLC_opsz_wdth_wght.ttf`,
and does not use Bahnschrift or parchment `#e8e4da`
Proof: `npx vitest run apps/web/test/styles.test.ts -t "defines product tokens and hosts Nunito Sans from cli help fonts"`

**C2** - Chrome wordmark is the text `Sheldon`; `apps/web` source has no `stix` string, no
equalizer identity markup, and no `--gradient-brand`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "wordmark is the text Sheldon"`
Proof: `npx vitest run apps/web/test/styles.test.ts -t "web chrome has no stix identity"`

### S2 - Shell · App.tsx + styles.css + server.ts · ~30k

**C3** - Titlebar shows `Sheldon`, `dashboard.path`, pill `neste computador`, **Atualizar**,
and a theme toggle; shell is full-viewport
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "titlebar shows Sheldon vault path loopback pill refresh and theme toggle"`

**C4** - Sidebar groups Bancada (Início, Fontes), Vault (Conhecimento, Revisão with pending
count, Consulta), Entrega (Bundles), Sistema (Configurações); footer `somente neste
computador`; active item has `navitem is-active`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "sidebar groups the seven sections and shows the pending review count"`

**C5** - At `max-width: 760px` CSS makes the sidebar nav a horizontal scroller and keeps the
titlebar
Proof: `npx vitest run apps/web/test/styles.test.ts -t "mobile breakpoint keeps titlebar and scrolls nav horizontally"`

### S3 - Início · App.tsx · ~12k

**C6** - Início title is `Fila e saúde do vault.`; four tiles bind queued/running/failed and
vault health; provenance rail is `raw → proposta → conceito`; **Nova fonte** opens Fontes
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "inicio tiles bind dashboard jobs and vault health and nova fonte opens fontes"`

### S4 - Fontes, Consulta, Bundles, Configurações · App.tsx · ~15k

**C7** - Fontes probe chips `OCR`, `STT`, and `rede` from effects/permissions; one primary
CTA on Fontes
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "fontes renders ocr stt rede chips and one primary cta"`

**C8** - Bundles JSON is not shown until preview is requested
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "bundles hides json until preview"`

### S5 - Conhecimento · KnowledgeView.tsx · ~8k

**C9** - Conhecimento still lists topics/projects, opens wiki HTML, follows in-wiki links,
shows sources/neighbours; empty copy unchanged; three cards; tree `260px`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists topic and project titles and wiki paths under the selected entity in path order"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "shows the existing empty copy when there are no topics and no projects"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "follows a relative wiki link to the target page"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists a source path and shows raw text when opened"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists outgoing and incoming neighbours and opens one"`
Proof: `npx vitest run apps/web/test/styles.test.ts -t "conhecimento tree column is 260px in a three-card layout"`

### S6 - Revisão, copy, tema, loopback, dashboard.path · ReviewView + server · ~20k

**C10** - Revisão lists pending proposals per topic; selects are not the only picker; opening
uses `GET /api/v1/reviews/topic/:slug/:proposalId`; empty copy
`Nenhuma proposta pendente neste vault.`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "lists pending proposals per topic and opens nested preview files"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "shows an empty state when no topic has a pending proposal"`

**C11** - Approve POSTs `confirmation` = proposal id and preview paths; reject POSTs
`confirmation` = proposal id and a reason; proposal id is visible; diff sits in a card
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "approves the wiki paths from the nested preview files"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "rejects with confirmation equal to the proposal id and a reason"`

**C12** - No `M7`, no emoji in chrome; theme toggle sets `[data-theme="dark"]`;
`prefers-reduced-motion` disables transitions; loopback 421 unchanged
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "chrome has no milestone leak and theme toggle sets data-theme dark"`
Proof: `npx vitest run apps/web/test/styles.test.ts -t "honors prefers-reduced-motion"`
Proof: `npx vitest run apps/web/test/server.test.ts -t "publishes a typed local contract without CORS and serves dashboard state"`

**C13** - `GET /api/v1/dashboard` includes `path` equal to the vault root; `health` / `jobs`
remain
Proof: `npx vitest run apps/web/test/server.test.ts -t "dashboard includes the vault path"`

## Swept

- validation: existing - `requireConfirmation` / reject reason
- failure modes: existing - preview and refresh error copy
- idempotency: n/a - restyle does not change writes
- authorization: existing - `WEB_LOCAL_ORIGIN_REQUIRED` (C12)
- concurrency: n/a - no new concurrent writes
- data lifecycle: n/a - optional `sheldon-web-theme` only
- dependency failure: existing - dashboard refresh error
- state transitions: C11
- observability: n/a - no new log/metric requirement

## Handoff

S1–S6 = one batch. All slices read `App.tsx` / `styles.css`; splitting would cut mid-surface.
