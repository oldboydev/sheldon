# Browse approved wiki as HTML in sheldon web

Sources:

- `.tasks/web-wiki-html.md` - criteria 1–9, doors, sweep, surface table
- `docs/prds/009-local-web-interface.md` - **binding for the interface**: area 3
  Conhecimento (tree, index, concept, sources, links, backlinks); no visual Markdown
  editor; UI consumes the local API; loopback only
- conversation - Conhecimento is a live local browser, not `sheldon help --html`

Profile: `light` (no `AGENTS.md` declaration). This feature has a UI; the floor does not
enumerate designed screens. Raise to `ui` to add that. Handoff: three slices, one batch.

## Out of scope

- Visual Markdown editor - PRD 009
- Graph visualisation - roadmap after MVP
- Static HTML export of the vault - PRD 009 is the live local UI
- Search/query UI completion - this task is Conhecimento
- Multi-vault switcher
- Serving wiki on a public host
- Help page `web.md` copy - Unresolved 1; Criterion 9 only keeps `help --html` as CLI help

## Landing

Read APIs on the Fastify server (`apps/web/src/wiki.ts` + routes in `server.ts`) consumed by
the existing React Conhecimento section. Wiki files stay Markdown on disk. Neighbours come
from `SearchIndex` when a compatible index already exists. Markdown HTML is a UI projection.

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| Live Conhecimento in `sheldon web`, not a static vault site | `GET /api/v1/entities/{kind}/{slug}/wiki` and `.../wiki/{path}` and `.../raw/{path}` consumed by the existing React section | dump HTML like `sheldon help --html` — that pipeline is CLI help; PRD 009 binds the local UI |
| Wiki files stay Markdown on disk; HTML is a read projection | GET page returns `id`, `title`, wiki-relative `path` (`wiki/...`), `body` (Markdown without YAML), `sources`; the UI renders HTML. No HTML files written into the vault | persist rendered HTML in the vault — would fork the source of truth from Markdown |
| Wiki/raw GETs read the vault from the Fastify server | confined helper `apps/web/src/wiki.ts` used by `createWebServer`; path stay inside the entity `wiki/` or `raw/` before `readFile` | new `WebApplication` CLI commands — there is no `wiki cat`; adding one is extra surface |
| Neighbours ride on the page GET from an existing search index | `SearchIndex.open` when `system/search-index.db` is compatible; map `backlink` → `incoming`; missing/corrupt index → `neighbours: []` | rebuild-on-GET — a valid page would 500 when another concept in the vault cannot index; a second neighbours route — Surface does not name one and `GET /search` requires `q` |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Knowledge tree · 8 files · 68 KB · ~17k

**C1** - Given a vault with at least one topic and one project that each have at least one
wiki page, when the user opens Conhecimento, then the tree lists those entities by title and,
under the selected entity, the wiki paths (`wiki/recall.md`, nested paths included) in path
order
Proof: `npx vitest run apps/web/test/server.test.ts -t "lists wiki paths under a topic and a project in path order"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists topic and project titles and wiki paths under the selected entity in path order"`

**C2** - Given a vault with no topics and no projects, when the user opens Conhecimento, then
the screen shows the existing empty copy `Nenhum tópico ainda. Crie um tópico antes de ingerir
uma fonte.` and does not invent placeholder pages
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "shows the existing empty copy when there are no topics and no projects"`

### S2 - Concept page as HTML · 8 files · 68 KB · ~17k

**C3** - Given an approved concept file with frontmatter `title` and a Markdown body that
includes an ATX heading, when the user opens that wiki path, then the screen shows that
`title` and HTML for the body (the heading text is present in the document). The YAML
frontmatter is not the main readable content
Proof: `npx vitest run apps/web/test/server.test.ts -t "returns wiki page title and markdown body without yaml frontmatter"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "shows the concept title and heading html without yaml as the main content"`

**C4** - Given a body link `[Study support](support.md)` to another wiki path in the same
entity, when the user activates it, then Conhecimento shows that target page. A missing
target stays on the current page and shows the existing API problem shape (404, `code` +
`message` + `recovery`)
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "follows a relative wiki link to the target page"`
Proof: `npx vitest run apps/web/test/server.test.ts -t "returns 404 ApiProblem for a missing wiki page"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "keeps the current page and shows ApiProblem fields when the wiki target is missing"`

**C5** - If the requested wiki path is outside that entity's `wiki/` directory
(`../secret.md`, absolute path, or a path not under `wiki/`), then the API responds 404 with
`ApiProblem` and the UI does not render file contents from outside `wiki/`
Proof: `npx vitest run apps/web/test/server.test.ts -t "returns 404 ApiProblem when the wiki path is outside wiki"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "does not render file contents from outside wiki"`

### S3 - Provenance and neighbours · 8 files · 68 KB · ~17k

**C6** - Given frontmatter `sources` listing `raw/source/content.md` and that file existing
under the entity, when the concept page is open, then that source path is listed and opening
it shows the raw file text. If the file is missing, the path is still listed and the open
state says it was not found (no crash, no path outside the entity)
Proof: `npx vitest run apps/web/test/server.test.ts -t "returns raw source text inside the entity and 404 when missing"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists a source path and shows raw text when opened"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists a missing source and says it was not found"`

**C7** - Given the search index has an outgoing or incoming neighbour for the open page in
the same entity, when the concept page is open, then those neighbours are listed (path +
relation `outgoing` or `incoming`) and activating one opens that wiki page
Proof: `npx vitest run apps/web/test/server.test.ts -t "includes same-entity neighbours as outgoing or incoming"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "lists outgoing and incoming neighbours and opens one"`

**C8** - Always, this screen does not edit wiki files, does not call an agent, and does not
bind outside loopback (existing `WEB_LOCAL_ORIGIN_REQUIRED` / 421)
Proof: `npx vitest run apps/web/test/server.test.ts -t "wiki and raw routes stay GET and still require loopback"`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "does not post wiki edits or queue an agent from conhecimento"`

**C9** - Always, `sheldon help --html` is unchanged (CLI help, not vault wiki)
Proof: `npx vitest run apps/cli/test/help.test.ts -t "html help remains the packaged cli guide not vault wiki"`

## Swept

- validation: C5
- failure modes: C4, C5, C6
- idempotency and retry: n/a - read-only GETs, no writes
- authorization: existing - loopback origin hook on the web server
- concurrency and ordering: existing - wiki files are the source of truth; a refresh re-reads
  disk. No new writer
- data lifecycle: n/a - nothing stored; HTML is a projection of Markdown on disk
- external-dependency failure: n/a - no network renderer
- state transitions: n/a - no lifecycle change
- observability: existing - `ApiProblem` codes on the JSON API

## Handoff

S1 + S2 + S3 share `server.ts`, `App.tsx`/`KnowledgeView`, and the new wiki helper (~66 KB
existing, ~17k tokens floor). Running total stays under 150k. No split.

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| entity kinds in the tree (2) | topic C1 · project C1 | - |
| wiki path escape (3) | `../secret.md` C5 · absolute C5 · not under `wiki/` C5 | - |
| wiki link target (2) | present C4 follow · missing C4 stay + ApiProblem | - |
| source open state (2) | exists C6 · missing C6 | - |
| neighbour relation (2) | `outgoing` C7 · `incoming` C7 | - |
| wiki GET routes (3) | list C1 · page C3 · raw C6 | - |
| help --html identity (1) | CLI guide C9 | - |

- Claims naming a status code, route or response shape: C4, C5, C6, C8 - each has a proof
  that crosses the HTTP boundary
- No other check claims more than the single case its proof exercises
