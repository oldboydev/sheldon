<!-- markdownlint-disable MD029 -->

# Browse approved wiki as HTML in sheldon web

> Build this with **tlc-implement**.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

`sheldon web` already has a Conhecimento section. It only prints each topic title and the
literal caption `wiki / raws / propostas`. Approved wiki lives as Markdown under
`topics/<slug>/wiki/` and `projects/<slug>/wiki/`. There is no way in the UI to open a page,
follow a wiki link, or see provenance. The CLI help HTML (`sheldon help --html`) is unrelated:
it documents commands, not the vault. PRD 009 named this screen; the implementation never
landed. The source gives no volume figure.

When this ships, Conhecimento is a read-only HTML browser of the approved wiki for the vault
opened by `sheldon web`: tree of topics and projects, one concept page at a time, wiki-links
and backlinks, cited raws openable when they live in that entity.

9 criteria in 3 slices · 1 one-way door · 1 open, of which 0 block

Sizing evidence: CONTRIBUTING does not declare task size; no GitHub issue yet; default is one
task. The three slices share the same read API and the same screen.

## Criteria

### Knowledge tree

1. Given a vault with at least one topic and one project that each have at least one wiki
   page, when the user opens Conhecimento, then the tree lists those entities by title and,
   under the selected entity, the wiki paths (`wiki/recall.md`, nested paths included)
   in path order.
2. Given a vault with no topics and no projects, when the user opens Conhecimento, then the
   screen shows the existing empty copy `Nenhum tópico ainda. Crie um tópico antes de ingerir
uma fonte.` and does not invent placeholder pages.

### Concept page as HTML

3. Given an approved concept file with frontmatter `title` and a Markdown body that includes
   an ATX heading, when the user opens that wiki path, then the screen shows that `title` and
   HTML for the body (the heading text is present in the document). The YAML frontmatter is
   not the main readable content.
4. Given a body link `[Study support](support.md)` to another wiki path in the same entity,
   when the user activates it, then Conhecimento shows that target page. A missing target
   stays on the current page and shows the existing API problem shape (404,
   `code` + `message` + `recovery`).
5. If the requested wiki path is outside that entity's `wiki/` directory (`../secret.md`,
   absolute path, or a path not under `wiki/`), then the API responds 404 with `ApiProblem`
   and the UI does not render file contents from outside `wiki/`.

### Provenance and neighbours

6. Given frontmatter `sources` listing `raw/source/content.md` and that file existing under
   the entity, when the concept page is open, then that source path is listed and opening it
   shows the raw file text. If the file is missing, the path is still listed and the open
   state says it was not found (no crash, no path outside the entity).
7. Given the search index has an outgoing or incoming neighbour for the open page in the
   same entity, when the concept page is open, then those neighbours are listed (path +
   relation `outgoing` or `incoming`) and activating one opens that wiki page.
8. Always, this screen does not edit wiki files, does not call an agent, and does not bind
   outside loopback (existing `WEB_LOCAL_ORIGIN_REQUIRED` / 421).
9. Always, `sheldon help --html` is unchanged (CLI help, not vault wiki).

## Out of scope

- Visual Markdown editor - PRD 009 out of scope
- Graph visualisation - roadmap "depois do MVP"
- Static HTML export of the vault (a second `help --html`) - PRD 009 is the live local UI
- Search/query UI completion (Consulta already queues jobs; this task is Conhecimento)
- Multi-vault switcher
- Serving wiki on a public host

## Observable

| Surface                                              | Decision              | Landing                                                                                        |
| ---------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| screen Conhecimento                                  | empty                 | 2                                                                                              |
| screen Conhecimento                                  | loading               | existing - dashboard refresh already covers in-flight; no extra spinner required by the source |
| screen Conhecimento                                  | error                 | 4, 5, 6                                                                                        |
| screen Conhecimento                                  | unauthorised          | existing - loopback 421                                                                        |
| screen Conhecimento                                  | density and ordering  | 1 - entities then wiki paths in path order                                                     |
| screen Conhecimento                                  | destructive confirm   | n/a - read-only                                                                                |
| API `GET /api/v1/entities/{kind}/{slug}/wiki`        | response shape        | 1 - list of wiki paths for that entity                                                         |
| API `GET /api/v1/entities/{kind}/{slug}/wiki/{path}` | response shape        | 3 - title, markdown/HTML body, sources                                                         |
| API `GET /api/v1/entities/{kind}/{slug}/wiki/{path}` | error shape and codes | 4, 5 - `ApiProblem`, 404                                                                       |
| API wiki routes                                      | who may call          | existing - loopback only                                                                       |
| API wiki routes                                      | versioning            | existing - `/api/v1`                                                                           |
| API wiki routes                                      | rate limit            | n/a - local single user                                                                        |
| command `sheldon web`                                | flags                 | existing - `--vault`, `--port`                                                                 |
| document help `web.md`                               | next step             | Unresolved 1                                                                                   |

## Swept

- validation: 5
- failure modes: 4, 5, 6
- idempotency and retry: n/a - read-only GETs, no writes
- authorization: existing - loopback origin hook on the web server
- concurrency and ordering: existing - wiki files are the source of truth; a refresh re-reads
  disk. No new writer.
- data lifecycle: n/a - nothing stored; HTML is a projection of Markdown on disk
- external-dependency failure: n/a - no network renderer
- state transitions: n/a - no lifecycle change
- observability: existing - `ApiProblem` codes on the JSON API

## Impact

| Front       | What changes                                                                   |
| ----------- | ------------------------------------------------------------------------------ |
| domain      | nothing - `topic`, `project`, wiki path, and concept frontmatter already exist |
| stored data | nothing to migrate                                                             |

`KnowledgeView` currently lists titles only. `WebApplication` has `listEntities` / `showEntity` /
`search` / `lintWiki` but no wiki-page read. Search already returns `relatedConcepts` for
same-entity neighbours.

## Decided

| Decision                                                    | Shape                                                                                                                                            | Alternative rejected                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Live Conhecimento in `sheldon web`, not a static vault site | read APIs under `/api/v1/entities/{kind}/{slug}/wiki` consumed by the existing React section                                                     | dump HTML like `sheldon help --html` - that pipeline is CLI help; PRD 009 binds the local UI |
| Wiki files stay Markdown on disk; HTML is a read projection | GET returns concept `id`, `title`, wiki-relative `path`, `body` (Markdown), `sources`; the UI renders HTML. No HTML files written into the vault | persist rendered HTML in the vault - would fork the source of truth from Markdown            |

## Surface

| Route                                            | In                                       | Out                                        | Status                  | Criteria   |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------ | ----------------------- | ---------- |
| `GET /api/v1/entities/{kind}/{slug}/wiki`        | `kind` (`topic`\|`project`), `slug`      | `{ path }[]` in path order                 | 200, 404 entity missing | 1, 2       |
| `GET /api/v1/entities/{kind}/{slug}/wiki/{path}` | `kind`, `slug`, wiki-relative path       | `id`, `title`, `path`, `body`, `sources`   | 200, 404                | 3, 4, 5, 6 |
| `GET /api/v1/entities/{kind}/{slug}/raw/{path}`  | `kind`, `slug`, entity-relative raw path | file text                                  | 200, 404                | 6          |
| Conhecimento                                     | selected entity + selected path          | tree + HTML article + sources + neighbours | n/a                     | 1–8        |

## Sources

- conversation - user asked to plan an HTML view of topics and wiki after confirming search
  is vault-wide and the current Conhecimento screen is a stub
- `docs/prds/009-local-web-interface.md` - **binding for the interface**: area 3
  Conhecimento (tree, index, concept, sources, links, backlinks); no visual Markdown editor;
  UI consumes the local API; loopback only
- `apps/web/src/App.tsx` KnowledgeView - current stub copy
- `packages/search` `relatedConcepts` - same-entity neighbours already indexed

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question                                                                                                                                                                                        | Until answered                                                                                                            |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | open | Should `apps/cli/help/pages/web.md` mention Conhecimento as a wiki browser after this ships? Default: yes, one sentence, because CONTRIBUTING requires README/help review for public behaviour. | Criterion 9 only covers `help --html` remaining CLI help. Help page `web.md` copy is not in the criteria until confirmed. |
