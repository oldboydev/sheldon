<!-- markdownlint-disable MD029 MD034 MD060 -->

# Render proposed wiki pages in Revisão and drop decided proposals

> Build this with **tlc-implement**.
> Every criterion below becomes a check with a proof, referenced by its number. Nothing under
> `Unresolved` gets settled while building.

## Intent

Revisão already lists pending proposals and can approve or reject them, but the reviewer
cannot read the proposed note. **Abrir revisão** dumps `file.diff.text` into a `<pre>`
(unified diff with `+` prefixes, YAML frontmatter, `--- a/` / `+++ b/` headers). Conhecimento
already renders approved wiki with `parseWikiMarkdown` and frontmatter stripped. After a
successful Aprovar, wiki files are written and `history/reviews/<id>.json` exists, yet the
same id stays in the pending list: `ProposalStatus` never leaves `pending`, `listPendingReviews`
ignores approval history and `review.json`, and `ReviewView` never refetches
`GET /api/v1/reviews`. A full **Atualizar** still shows the item. Observed on
`@oldboydev/sheldon@0.2.6` against vault `C:\Users\paulo\vaults\sheldon`, topic observability,
proposals `proposal-observability-notes` / `proposal-observability-notes-3`. The source gives
no volume figure.

When this ships, Revisão shows each create/modify file as a readable wiki page (frontmatter
stripped, body via `parseWikiMarkdown`) with a compact colored diff as secondary support, plus
the preview's fontes / afirmações / contradições. After a successful approve or reject,
`GET /api/v1/reviews` omits that id, the Revisão list and the sidebar pending count drop it
without a full reload, and the success or reject banner still appears.

11 criteria in 2 slices · 2 one-way doors · 2 open, of which 0 block

Sizing evidence: CONTRIBUTING does not declare task size; GitHub issue #41 is one bug;
default is one task. The two slices share `ReviewView`, `GET /api/v1/reviews`, and the same
preview JSON.

## Criteria

### Proposed document

1. Given a pending create or modify file whose stored Markdown has YAML frontmatter (`id`,
   `title`) and an ATX heading (for example `# Wide events`), when the user opens that
   proposal in Revisão, then the screen shows that heading text in HTML. It does not use a
   `<pre>` whose only content is unified-diff lines starting with `+id:` / `+title:` as the
   page body. YAML frontmatter is not the rendered page body.
2. Always, the proposed Markdown comes from the stored proposal content exposed as preview
   file `content` (create and modify). The UI does not reconstruct the page only from
   `diff.text`. Delete files omit `content`.
3. Given a preview file with `operation` `delete`, when the proposal is open, then that file
   shows the copy `Este caminho será removido.` plus a compact diff. It does not render a
   wiki page body for the deleted path.
4. Given an open preview, a compact per-file diff remains available: the path, added and
   removed counts, and colored add/remove lines. The raw `--- a/` / `+++ b/` dump is not the
   only representation of the change.
5. Given a preview that includes `sources`, `claims`, and `contradictions`, when the proposal
   is open, then those lists render with the pt-BR labels `Fontes`, `Afirmações`, and
   `Contradições`.

### Pending list

6. Given a proposal whose `history/reviews/<id>.json` exists after a successful approve, when
   `GET /api/v1/reviews` (or `listPendingReviews`) runs, then that id is omitted even if
   `metadata.status` is still `pending`.
7. Given a proposal whose `outputs/proposals/<id>/review.json` exists after a successful
   reject, when `GET /api/v1/reviews` (or `listPendingReviews`) runs, then that id is omitted
   even if `metadata.status` is still `pending`.
8. Given an open preview, when approve POST succeeds, then the copy `Arquivos aprovados e
promovidos para a wiki.` appears, a following list fetch omits that proposal id, the
   Revisão list drops it, and the sidebar pending count drops it, without a full page reload.
   The POST stays `{ confirmation: <proposalId>, paths: <preview paths> }` on
   `/api/v1/reviews/topic/:slug/:proposalId/approve`.
9. Given an open preview, when reject POST succeeds with a non-empty reason, then the copy
   `Proposta rejeitada.` appears, and the same list and sidebar-count drop happens. The POST
   stays `{ confirmation: <proposalId>, reason }` on
   `/api/v1/reviews/topic/:slug/:proposalId/reject`.
10. Given the last pending proposal was dropped, the Revisão empty copy is `Nenhuma proposta
pendente neste vault.` and the success or reject banner still appears.
11. Always, loopback / `WEB_LOCAL_ORIGIN_REQUIRED` is unchanged. Existing GET/POST review
    URLs stay. `apps/cli/help/pages/web.md` describes **Abrir revisão** as rendering the
    proposed wiki page plus a compact diff.

## Out of scope

- Visual Markdown editor, in-place edit of the proposal, graph, vault HTML export — issue #41
- Filling the job list from CLI compile — issue #41
- Changing `sheldon help --html` — issue #41
- Electron / desktop shell — issue #41
- New ingest/compile/agent behaviour — issue #41
- Extending `ProposalStatus` with `approved` / `rejected` — issue prefers existing records
  unless a status extension is cheaper; existing approved vault rows stay `pending` in
  metadata, so a status-only filter would not drop them
- Listing project proposals in Revisão — `listPendingReviews` already lists topics only;
  the issue does not add projects
- Blocking a second approve of an already-applied proposal — the issue drops it from the
  list; `assertPromotable` stays as it is

## Observable

| Surface                                           | Decision              | Landing                                                                                               |
| ------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| screen Revisão                                    | empty                 | 10                                                                                                    |
| screen Revisão                                    | loading               | existing - Abrir revisão already replaces preview in place                                            |
| screen Revisão                                    | error                 | existing - preview/approve/reject already show `message`                                              |
| screen Revisão                                    | unauthorised          | existing - loopback 421                                                                               |
| screen Revisão                                    | density and ordering  | 1, 4, 5 - page, then compact diff, then fontes/afirmações/contradições                                |
| screen Revisão                                    | destructive confirm   | existing - approve still requires `confirmation=proposalId`; reject still requires a non-empty reason |
| API `GET /api/v1/reviews`                         | response shape        | 6, 7 - `{ topics }` omitting decided ids                                                              |
| API `GET /api/v1/reviews`                         | error shape and codes | existing - `ApiProblem` / command errors                                                              |
| API `GET /api/v1/reviews/:kind/:slug/:proposalId` | response shape        | 2 - additive `content` on create/modify files                                                         |
| API `POST .../approve`                            | who may call, body    | 8 - `confirmation` + `paths`                                                                          |
| API `POST .../reject`                             | who may call, body    | 9 - `confirmation` + `reason`                                                                         |
| API review routes                                 | versioning            | existing - `/api/v1`                                                                                  |
| API review routes                                 | rate limit            | n/a - local single user                                                                               |
| command `sheldon web`                             | flags                 | existing - `--vault`, `--port`                                                                        |
| document help `web.md`                            | next step             | 11                                                                                                    |

## Swept

- validation: existing - reject still requires a non-empty reason; approve still requires
  `confirmation=proposalId` and preview paths
- failure modes: existing - preview/approve/reject already surface `message`; 3 covers delete
- idempotency and retry: 6, 7 - a second `GET /api/v1/reviews` after approve or reject still
  omits the id because the history or `review.json` record remains
- authorization: existing - loopback origin hook on the web server (11)
- concurrency and ordering: n/a - one local user; list re-reads disk on each GET
- data lifecycle: 6, 7 - decided means the records already written (`history/reviews/<id>.json`,
  `outputs/proposals/<id>/review.json`); no new store
- external-dependency failure: n/a - no network renderer
- state transitions: 6, 7, 8, 9 - user-visible pending list membership; persisted
  `ProposalStatus` stays `pending \| cancelled \| error`
- observability: existing - `ApiProblem` codes on the JSON API

## Impact

| Front       | What changes                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain      | existing term: pending review — `listPendingReviews` meant `metadata.status === 'pending'`; it now also requires that `history/reviews/<id>.json` and `outputs/proposals/<id>/review.json` are absent. Callers: `GET /api/v1/reviews`, Revisão list, App sidebar count, CLI JSON list |
| domain      | existing term: `ReviewPreviewFile` gains optional `content` (full proposed Markdown) for create and modify. Callers: CLI `review preview` JSON, `GET /api/v1/reviews/:kind/:slug/:proposalId`, `ReviewView`                                                                           |
| stored data | nothing to migrate — filter existing history and rejection files; additive JSON field                                                                                                                                                                                                 |

## Decided

| Decision                                                            | Shape                                                                                                                                        | Alternative rejected                                                                                                                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proposed page comes from stored Markdown, not from the unified diff | additive `content?: string` on `ReviewPreviewFile` for create/modify; omitted on delete; UI strips YAML and renders with `parseWikiMarkdown` | reconstruct the page only from `diff.text` — issue forbids it; `+` lines and bounded-diff summaries are not the document                                                                                          |
| Pending list consults records already written                       | omit an id when `history/reviews/<id>.json` or `outputs/proposals/<id>/review.json` exists, in addition to `metadata.status === 'pending'`   | extend `ProposalStatus` with `approved`/`rejected` — would not drop already-approved vault rows whose metadata stays `pending`, and would persist a second status machine the issue asked to avoid unless cheaper |

## Surface

| Route                                                  | In                        | Out                                                                                         | Status   | Criteria       |
| ------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- | -------- | -------------- |
| `GET /api/v1/reviews`                                  | none                      | `{ topics: { slug, title, proposals: { id, agent, createdAt }[] }[] }` omitting decided ids | 200      | 6, 7, 8, 9, 10 |
| `GET /api/v1/reviews/:kind/:slug/:proposalId`          | kind, slug, proposalId    | existing `ReviewPreview` plus per-file `content` on create/modify                           | 200      | 1, 2, 3, 4, 5  |
| `POST /api/v1/reviews/:kind/:slug/:proposalId/approve` | `confirmation`, `paths`   | existing approve JSON                                                                       | 200, 400 | 8              |
| `POST /api/v1/reviews/:kind/:slug/:proposalId/reject`  | `confirmation`, `reason`  | existing reject JSON                                                                        | 200, 400 | 9              |
| Revisão                                                | selected topic + proposal | wiki page HTML, compact diff, fontes/afirmações/contradições, pending list, sidebar count   | n/a      | 1–11           |

## Sources

- https://github.com/oldboydev/sheldon/issues/41 - **binding**: render proposed wiki pages,
  compact diff secondary, drop decided ids using existing records, refresh list and sidebar
  count, surface sources/claims/contradictions, keep POST confirmation contract
- `docs/prds/009-local-web-interface.md` - Revisão: diff por arquivo, afirmações, contradições,
  citações e ações; no visual Markdown editor
- `apps/web/src/KnowledgeView.tsx`, `apps/web/src/wiki-markdown.ts`, `apps/web/src/wiki.ts`
  `parseConcept` - reuse the approved-wiki renderer and frontmatter strip
- `packages/review/src/review-service.ts` - `ReviewPreview` / `preview()` / history write
- `apps/cli/src/commands/memory.ts` - `listPendingReviews`, `previewProposal`
- `apps/cli/src/commands/workflow.ts` - reject writes `review.json`
- conversation - Paulo asked for a readable wiki page (frontmatter stripped); colored +/-
  diff can stay as secondary support

This task is the record of decision. If a linked document diverges, ask before building.

## Unresolved

| #   | Kind | Question                                                                           | Until answered                                                                                                |
| --- | ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | open | Should wiki links inside a proposed (unpublished) page navigate like Conhecimento? | Default: render with `parseWikiMarkdown`; wiki hrefs display as links and do not fetch the approved-wiki API. |
| 2   | open | Exact compact-diff chrome (counts only vs colored +/- lines in a `<details>`).     | Criterion 4 requires path + counts + colored add/remove lines. Layout inside that bound is reversible.        |
