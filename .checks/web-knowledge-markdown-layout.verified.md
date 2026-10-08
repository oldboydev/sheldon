# Format Conhecimento wiki body and layout Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: main..29483229e05bfb9cd196468624c9ddfbb43ee73b
**Round**: 2 - scoped
**Verifier**: independent sub-agent (author != verifier)

Round 1 FAIL at `b8886bf` was C4 (`ol li` unproven). Fix `2948322` (`test(web): assert ordered wiki lists in Conhecimento`) adds `1. **First**` to the fixture and `querySelectorAll('ol li')`. Proofs re-run in full at `2948322`. Step 1 UI enumeration, Coverage join, Test policy, and fault injection skipped (profile light).

## Binding sources

carried from `b8886bf` (step 1 ui skipped both rounds; sources unchanged)

| Source | Opened | Contradiction | Uncovered |
|---|---|---|---|
| conversation 2026-10-08 screenshot of Conhecimento | no — screenshot not openable; used the checklist conversation bullets as the binding claims | none against C1–C8 | skipped (profile light, step 1 ui) |
| `.interface-design/system.md` | yes | none — three cards, tree ~260px, magenta action, pt-BR copy | skipped (profile light, step 1 ui) |
| `docs/prds/009-local-web-interface.md` area 3 | yes | none — árvore/índice/conceito/fontes/links/backlinks; no visual Markdown editor; UI consumes local API | skipped (profile light, step 1 ui) |

## Checks

| Check | Claim | Proof run | Evidence | Result |
|---|---|---|---|---|
| C1 | `-` / `1.` lines become list blocks (`ordered: false` / `true`), not one joined paragraph | re-run at `2948322` — **parses unordered and ordered lists as list blocks** passed | `apps/web/test/wiki-markdown.test.ts:7` `expect(parseWikiMarkdown('- Alpha\n- Bravo\n')).toEqual([{ type: 'list', ordered: false, items: … }])`; `:14` `ordered: true` | PASS — verified at `2948322` |
| C2 | `**Query**` → `strong`, `` `COUNT` `` → `code`, bare `https://example.com/x` → non-wiki `link`; `[docs](https://example.com/b)` stays one link | re-run at `2948322` — **parses strong code and autolinks without double-linking markdown urls** passed | `apps/web/test/wiki-markdown.test.ts:29` `{ type: 'strong', … value: 'Query' }`; `:31` `{ type: 'code', value: 'COUNT' }`; `:43-47` autolink `wiki: false`; `:50` single markdown link `text: 'docs'` | PASS — verified at `2948322` |
| C3 | title `Active recall` + body `# Active recall` shown once as article heading; no `.wiki-body h1` with that text | re-run at `2948322` — **does not repeat the page title as a body h1** passed | `apps/web/test/knowledge-view.test.tsx:200` `expect(container!.querySelector('.wiki-article > h2')?.textContent).toBe('Active recall')`; `:201` `expect(container!.querySelector('.wiki-body h1')).toBeNull()` | PASS — verified at `2948322` |
| C4 | body with `- Alpha`, `1. **First**`, `` `COUNT` ``, `https://example.com/x` renders `ul li`, `ol li`, `strong`, `code`, `a[href="https://example.com/x"]` | re-run at `2948322` — **renders lists strong code and autolinks in the wiki body** passed | fixture `apps/web/test/knowledge-view.test.tsx:20-25` includes `- Alpha` and `1. **First**`; `:210` `querySelectorAll('ul li')` → `['Alpha','Bravo']`; `:214` `querySelectorAll('ol li')` → `['First']`; `:215` `p strong` → `'Query'`; `:216` `code` → `'COUNT'`; `:217` `a[href="https://example.com/x"]` not null | PASS — verified at `2948322` |
| C5 | `GET /api/v1/entities/topic/memory/wiki` returns `{ path, title }` in path order; titles `Active recall`, `Study support`, `Nested concept` | re-run at `2948322` — **lists wiki paths under a topic and a project in path order** passed | `apps/web/test/server.test.ts:176-182` inject `'/api/v1/entities/topic/memory/wiki'` `statusCode` 200 `toEqual([{ path: 'wiki/concepts/nested.md', title: 'Nested concept' }, { path: 'wiki/recall.md', title: 'Active recall' }, { path: 'wiki/support.md', title: 'Study support' }])` | PASS — verified at `2948322` |
| C6 | tree visible label `Active recall`; `data-wiki-path` remains `wiki/recall.md`; open path has `is-active` | re-run at `2948322` — **shows concept titles in the tree and marks the open path active** passed | `apps/web/test/knowledge-view.test.tsx:223-224` `[data-wiki-path="wiki/recall.md"]` `textContent` `'Active recall'`; `:229` `classList.contains('is-active')` | PASS — verified at `2948322` |
| C7 | neighbours `saindo` / `entrando` not `outgoing` / `incoming`; source and neighbour controls are not `.quiet` | re-run at `2948322` — **labels neighbours saindo and entrando without quiet buttons** passed | `apps/web/test/knowledge-view.test.tsx:236-238` `/saindo/`, not `outgoing`, `.wiki-aside .quiet` null; `:240-241` `/entrando/`, not `incoming` | PASS — verified at `2948322` |
| C8 | `.page.wiki-page` max-width > 1100px; `.wiki-body ul` styled; `.wiki-paths .is-active` exists; `.wiki-aside` overflow-wrap; `.wiki-aside .provenance` wraps | re-run at `2948322` — **conhecimento article layout wraps paths and styles wiki lists** passed | `apps/web/test/styles.test.ts:51` `toBeGreaterThan(1100)`; `:52` `/\.wiki-body ul\b/`; `:53` `/\.wiki-paths[\s\S]*\.is-active/`; `:54` `/\.wiki-aside[\s\S]*overflow-wrap/`; `:56` `flex-wrap:\s*wrap\|white-space:\s*normal` | PASS — verified at `2948322` |

## Swept (existing constraints)

carried from `b8886bf` (fix `2948322` touches only `apps/web/test/knowledge-view.test.tsx` C4 fixture/assertion)

| Row | Cited constraint | Present |
|---|---|---|
| validation: wiki path confinement unchanged (C5 reuses list route) | `confinedPath` / `confinedExistingFile` on wiki+raw reads; list walks `wikiRoot` only | yes — `apps/web/src/wiki.ts:110-134` |
| failure modes: missing wiki/raw still 404 | `WikiNotFoundError` → 404 | yes — `apps/web/src/server.ts:308-311` |
| idempotency: GET-only; Conhecimento does not POST | wiki/raw are `server.get`; view fetches GET | yes — `knowledge-view.test.tsx` GET-only assertion still present |
| authorization: loopback required | `onRequest` host/origin gate | yes — `apps/web/src/server.ts:42-55` |
| dependency failure: missing search index still `neighbours: []` | `SearchIndex.open` catch returns `[]` | yes — `apps/web/src/wiki.ts:199-202` |
| concurrency / state transitions / observability | not in scope | n/a |

## Test policy rows

skipped — profile light (checklist has no `## Test policy` section)

## Faults injected

skipped — profile light

## Gate

`npx vitest run apps/web/test/wiki-markdown.test.ts apps/web/test/knowledge-view.test.tsx apps/web/test/server.test.ts apps/web/test/styles.test.ts --reporter=verbose` at `2948322` — 35 passed, 0 failed (4 files). All eight named proofs appeared individually and passed.
