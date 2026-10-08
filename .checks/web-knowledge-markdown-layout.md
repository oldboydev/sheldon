# Format Conhecimento wiki body and layout

Sources:

- conversation 2026-10-08 - **binding for the interface**: screenshot of Conhecimento on
  vault `C:\Users\paulo\vaults\sheldon`, topic AI Harness, page
  `wiki/harness-app-cli-diretrizes.md`. Body has no lists/bold/code/autolink; title
  duplicated; tree wraps `wiki/*.md`; aside hashes wrap in magenta; provenance chip
  overflows; neighbours show English `outgoing`/`incoming`
- `.interface-design/system.md` - Conhecimento is three cards (tree ~260px · article ·
  fontes/vizinhos); Nunito; magenta is the single action color; pt-BR
- `docs/prds/009-local-web-interface.md` - area 3 Conhecimento; no visual Markdown editor;
  UI consumes the local API

Profile: `light` (no `AGENTS.md` declaration). This feature has a UI; the floor does not
enumerate designed screens. Handoff: one batch.

## Out of scope

- Visual Markdown editor - PRD 009
- Tables, fenced code, blockquotes, nested lists, GFM - conversation bounded the parser
- Graph visualisation
- Opening `../raw/*.md` wiki-style links as raw sources
- Changing ReviewView beyond sharing `parseWikiMarkdown` (Revisão is PR #42)
- Electron / public host / vault switcher

## Landing

Keep the custom line parser in `apps/web/src/wiki-markdown.ts`. HTML stays a read
projection. List endpoint gains additive `title` from concept frontmatter. Tree still
exposes `data-wiki-path`. Neighbour relations stay `outgoing`/`incoming` on the wire;
the UI maps them to `saindo`/`entrando`.

| One-way door                            | Literal shape                                                                                            | Alternative rejected                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Wiki list items include concept title   | additive `title: string` on `GET .../wiki` items; UI label is that title, path stays in `data-wiki-path` | N+1 page fetches from the tree, or filename-only labels that keep wrapping `wiki/*.md` |
| Parser stays custom, not a Markdown lib | extend `parseWikiMarkdown` with list / strong / code / autolink blocks                                   | add `marked`/`markdown-it` — extra dependency and a second HTML sanitizer surface      |

- Nothing else in this change is hard to reverse

## Checks

### S1 - Wiki Markdown projection · 3 files · ~24 KB · ~6k

**C1** - Given Markdown lines that start with `-` or `1.` plus a space, `parseWikiMarkdown`
returns a `list` block (`ordered: false` for dash, `ordered: true` for `1.`) with one item per
line, not one paragraph that joins the lines
Proof: `npx vitest run apps/web/test/wiki-markdown.test.ts -t "parses unordered and ordered lists as list blocks"`

**C2** - Given `**Query**` and `` `COUNT` `` in a paragraph, the parser emits `strong` and
`code` inlines. A bare `https://example.com/x` becomes a non-wiki `link`. A Markdown
`[docs](https://example.com/b)` stays a single link and is not autolinked again
Proof: `npx vitest run apps/web/test/wiki-markdown.test.ts -t "parses strong code and autolinks without double-linking markdown urls"`

**C3** - Given a page whose `title` is `Active recall` and whose body starts with
`# Active recall`, Conhecimento shows that title once as the article heading and does not
render a `.wiki-body h1` with the same text
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "does not repeat the page title as a body h1"`

**C4** - Given a body with `- Alpha`, `1. **First**`, `` `COUNT` `` and
`https://example.com/x`, Conhecimento renders `ul li`, `ol li`, `strong`, `code`, and
`a[href="https://example.com/x"]`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "renders lists strong code and autolinks in the wiki body"`

### S2 - Tree and aside layout · 5 files · ~40 KB · ~10k

**C5** - `GET /api/v1/entities/topic/memory/wiki` returns items `{ path, title }` in path
order, with `title` taken from concept frontmatter (`Active recall`, `Study support`,
`Nested concept`)
Proof: `npx vitest run apps/web/test/server.test.ts -t "lists wiki paths under a topic and a project in path order"`

**C6** - The Conhecimento tree shows those titles as the visible label (`Active recall`)
while `data-wiki-path` remains `wiki/recall.md`. The open path has class `is-active`
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "shows concept titles in the tree and marks the open path active"`

**C7** - Neighbours show `saindo` and `entrando` instead of `outgoing` and `incoming`.
Source and neighbour controls are not `.quiet` buttons
Proof: `npx vitest run apps/web/test/knowledge-view.test.tsx -t "labels neighbours saindo and entrando without quiet buttons"`

**C8** - CSS: `.page.wiki-page` max-width is greater than 1100px; `.wiki-body ul` is
styled; `.wiki-paths .is-active` exists; `.wiki-aside` uses `overflow-wrap`;
`.wiki-aside .provenance` allows wrapping (`flex-wrap` or `white-space` other than
`nowrap` only)
Proof: `npx vitest run apps/web/test/styles.test.ts -t "conhecimento article layout wraps paths and styles wiki lists"`

## Swept

- validation: existing wiki path confinement unchanged (C5 reuses the list route)
- failure modes: missing wiki/raw still 404 — existing knowledge-view tests
- idempotency: GET-only; Conhecimento still does not POST (existing test)
- authorization: loopback already required by server tests
- concurrency: not in scope — read UI
- data lifecycle: Markdown stays on disk; HTML is a projection
- dependency failure: missing search index still `neighbours: []` — unchanged
- state transitions: not in scope
- observability: not in scope

## Coverage

| Set (size)            | Member -> proof                   | Unproven |
| --------------------- | --------------------------------- | -------- |
| block kinds added (2) | unordered C1 · ordered C1         | -        |
| inlines added (3)     | strong C2 · code C2 · autolink C2 | -        |
| neighbour labels (2)  | saindo C7 · entrando C7           | -        |

- Claims naming a status code, route or response shape: C5
- No other check claims more than the single case its proof exercises

## Handoff

S1-S2 = ~16k floor, one batch. Surface is `apps/web` only.
