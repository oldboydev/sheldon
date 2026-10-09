# Render proposed wiki pages in Revisão and drop decided proposals

Sources:

- `.tasks/web-review-preview-and-pending.md` - criteria 1–11, doors, sweep, surface table
- [issue #41](https://github.com/oldboydev/sheldon/issues/41) - **binding**: proposed wiki HTML, compact
  diff secondary, drop decided ids via existing records, refresh list and sidebar, fontes /
  afirmações / contradições, POST confirmation contract
- `docs/prds/009-local-web-interface.md` - Revisão: diff por arquivo, afirmações,
  contradições, citações e ações; no visual Markdown editor

Profile: `light` (no `AGENTS.md` declaration). This feature has a UI; the floor does not
enumerate designed screens. Raise to `ui` to add that. Handoff: two slices, one batch.

## Out of scope

- Visual Markdown editor, in-place edit, graph, vault HTML export - issue #41
- Filling the job list from CLI compile - issue #41
- Changing `sheldon help --html` - issue #41
- Electron / desktop shell - issue #41
- New ingest/compile/agent behaviour - issue #41
- Extending `ProposalStatus` - issue prefers existing records; already-approved vault rows
  stay `pending` in metadata
- Listing project proposals in Revisão - `listPendingReviews` already lists topics only
- Blocking a second approve of an already-applied proposal - list drop only

## Landing

Revisão consumes the existing GET/POST review URLs. Preview gains additive `content` on
create/modify files. The pending list omits ids that already have `history/reviews/<id>.json`
or `outputs/proposals/<id>/review.json`. The UI reuses `parseWikiMarkdown` (same renderer as
Conhecimento) and refetches `GET /api/v1/reviews` after approve/reject so the list and the
sidebar count drop together.

| One-way door                                  | Literal shape                                                                                                                         | Alternative rejected                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Proposed page comes from stored Markdown      | additive `content?: string` on `ReviewPreviewFile` for create/modify; omitted on delete                                               | reconstruct from `diff.text` - issue forbids it; bounded diffs are not the document                 |
| Pending list consults records already written | omit when `history/reviews/<id>.json` or `outputs/proposals/<id>/review.json` exists, still requiring `metadata.status === 'pending'` | extend `ProposalStatus` - would not drop already-approved vault rows whose metadata stays `pending` |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Proposed document · 9 files · ~72 KB · ~18k

**C1** - Given a pending create or modify file whose stored Markdown has YAML frontmatter
(`id`, `title`) and an ATX heading (for example `# Wide events`), when the user opens that
proposal in Revisão, then the screen shows that heading text in HTML. It does not use a
`<pre>` whose only content is unified-diff lines starting with `+id:` / `+title:` as the
page body. YAML frontmatter is not the rendered page body
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "renders the proposed wiki heading as html without yaml or unified-diff plus-lines as the page body"`

**C2** - Always, the proposed Markdown comes from the stored proposal content exposed as
preview file `content` (create and modify). The UI does not reconstruct the page only from
`diff.text`. Delete files omit `content`
Proof: `npx vitest run packages/review/test/review-service.test.ts -t "includes proposed markdown content on create and modify preview files and omits it on delete"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "renders the proposed body from file content not from diff text"`

**C3** - Given a preview file with `operation` `delete`, when the proposal is open, then that
file shows the copy `Este caminho será removido.` plus a compact diff. It does not render a
wiki page body for the deleted path
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "shows delete copy and compact diff for a delete file"`

**C4** - Given an open preview, a compact per-file diff remains available: the path, added
and removed counts, and colored add/remove lines. The raw `--- a/` / `+++ b/` dump is not
the only representation of the change
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "keeps a compact per-file diff with add and remove counts"`

**C5** - Given a preview that includes `sources`, `claims`, and `contradictions`, when the
proposal is open, then those lists render with the pt-BR labels `Fontes`, `Afirmações`, and
`Contradições`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "surfaces sources claims and contradictions with pt-BR labels"`

**C11** - Always, loopback / `WEB_LOCAL_ORIGIN_REQUIRED` is unchanged. Existing GET/POST
review URLs stay. `apps/cli/help/pages/web.md` describes **Abrir revisão** as rendering the
proposed wiki page plus a compact diff
Proof: `npx vitest run apps/web/test/server.test.ts -t "publishes a typed local contract without CORS and serves dashboard state"`
Proof: `npx vitest run apps/web/test/server.test.ts -t "requires the exact proposal confirmation before forwarding approval to the facade"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "approves the wiki paths from the nested preview files"`
Proof: `npx vitest run apps/cli/test/help.test.ts -t "web help describes abrir revisao as proposed wiki page plus compact diff"`

### S2 - Pending list · 6 files · ~48 KB · ~12k

**C6** - Given a proposal whose `history/reviews/<id>.json` exists after a successful
approve, when `GET /api/v1/reviews` (or `listPendingReviews`) runs, then that id is omitted
even if `metadata.status` is still `pending`
Proof: `npx vitest run apps/cli/test/review-list.test.ts -t "omits a proposal after history/reviews id json exists"`

**C7** - Given a proposal whose `outputs/proposals/<id>/review.json` exists after a
successful reject, when `GET /api/v1/reviews` (or `listPendingReviews`) runs, then that id
is omitted even if `metadata.status` is still `pending`
Proof: `npx vitest run apps/cli/test/review-list.test.ts -t "omits a proposal after outputs/proposals id/review.json exists"`

**C8** - Given an open preview, when approve POST succeeds, then the copy `Arquivos aprovados
e promovidos para a wiki.` appears, a following list fetch omits that proposal id, the
Revisão list drops it, and the sidebar pending count drops it, without a full page reload.
The POST stays `{ confirmation: <proposalId>, paths: <preview paths> }` on
`/api/v1/reviews/topic/:slug/:proposalId/approve`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "drops the approved proposal from the list, keeps the success banner, and notifies the parent"`
Proof: `npx vitest run apps/web/test/app-shell.test.tsx -t "sidebar pending count drops after a successful approve without a full reload"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "approves the wiki paths from the nested preview files"`

**C9** - Given an open preview, when reject POST succeeds with a non-empty reason, then the
copy `Proposta rejeitada.` appears, and the same list and sidebar-count drop happens. The
POST stays `{ confirmation: <proposalId>, reason }` on
`/api/v1/reviews/topic/:slug/:proposalId/reject`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "drops the rejected proposal from the list, keeps the rejected banner, and notifies the parent"`
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "rejects with confirmation equal to the proposal id and a reason"`

**C10** - Given the last pending proposal was dropped, the Revisão empty copy is `Nenhuma
proposta pendente neste vault.` and the success or reject banner still appears
Proof: `npx vitest run apps/web/test/review-view.test.tsx -t "shows empty pending copy and the success banner after the last proposal is decided"`

## Swept

- validation: existing - reject still requires a non-empty reason; approve still requires
  `confirmation=proposalId` and preview paths (C8, C9, C11)
- failure modes: existing - preview/approve/reject already surface `message`; C3 covers delete
- idempotency and retry: C6, C7 - a second GET after approve or reject still omits the id
  because the history or `review.json` record remains
- authorization: existing - loopback origin hook (C11)
- concurrency and ordering: n/a - one local user; list re-reads disk on each GET
- data lifecycle: C6, C7 - decided means the records already written; no new store
- external-dependency failure: n/a - no network renderer
- state transitions: C6, C7, C8, C9 - user-visible pending list membership; persisted
  `ProposalStatus` stays `pending | cancelled | error`
- observability: existing - `ApiProblem` codes on the JSON API

## Coverage

| Set (size)                  | Member -> proof                                                        | Unproven |
| --------------------------- | ---------------------------------------------------------------------- | -------- |
| preview file operations (3) | create/modify page HTML C1 · content field C2 · delete copy C3         | -        |
| decided records (2)         | approve history C6 · reject `review.json` C7                           | -        |
| POST contracts (2)          | approve confirmation+paths C8, C11 · reject confirmation+reason C9     | -        |
| after-decide UI (4)         | list drop C8/C9 · sidebar count C8 · banner C8/C9/C10 · empty copy C10 | -        |

- Claims naming a status code, route or response shape: C6, C7, C8, C9, C11 - each has a
  proof that crosses the list GET or the approve/reject POST (C11 also the loopback Origin)
- No other check claims more than the single case its proof exercises

## Handoff

S1 + S2 = ~30k, both in `apps/web` + `packages/review` + `apps/cli` list/help. One batch;
no mid-feature handoff.
