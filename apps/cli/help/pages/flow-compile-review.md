# Compile then review

End-to-end path from an immutable raw capture to approved wiki notes: ingest → compile → preview → approve.

## Steps

1. Capture a source into `raw/<source-id>/` (file, url, crawl, or repository).
2. Ask an agent to compile selected raws into a proposal.
3. Preview the proposal without writing wiki.
4. Approve only the paths you want applied.

## Capture a raw

Install a connector if needed, then ingest.

PowerShell:

```powershell
sheldon plugin install source.file
sheldon ingest file topic learning C:\inbox\article.pdf --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon plugin install source.file
sheldon ingest file topic learning ~/inbox/article.pdf --vault ~/knowledge/sheldon
```

Note the source id and normalized path from the JSON output (typically `raw/<source-id>/content.md`).

## Compile a proposal

PowerShell:

```powershell
sheldon compile topic learning proposal-article `
  --agent codex `
  --prompt "Extract practical ideas and create concise notes with sources." `
  --raw raw/<source-id>/content.md `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon compile topic learning proposal-article \
  --agent codex \
  --prompt "Extract practical ideas and create concise notes with sources." \
  --raw raw/<source-id>/content.md \
  --vault ~/knowledge/sheldon
```

Use `sheldon agent doctor` if the agent is missing or not logged in. For another attempt linked to the first, use `compile-retry` with a new proposal id and `--from`.

## Preview

```powershell
sheldon review preview topic learning proposal-article --vault C:\knowledge\sheldon
```

```sh
sheldon review preview topic learning proposal-article --vault ~/knowledge/sheldon
```

Inspect the listed file paths before applying anything.

## Approve selected paths

PowerShell:

```powershell
sheldon review approve topic learning proposal-article wiki/practical-ideas.md `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon review approve topic learning proposal-article wiki/practical-ideas.md \
  --vault ~/knowledge/sheldon
```

Only the paths you pass are written into `wiki/`. Reject with `sheldon review reject … --reason` if the proposal should not land.

## Next

- Command details: [ingest](ingest.html), [compile](compile.html), [review](review.html)
- After approval, try [search](search.html) or [query](query.html)
- Back to [Sheldon help](../index.html)
