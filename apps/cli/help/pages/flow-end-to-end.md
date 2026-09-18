# End-to-end flow

Happy path from an empty machine to searchable, queryable wiki notes: `init` → ingest → compile → review → `search` / `query`.

Sheldon does **not** list vaults. After `init`, rely on the saved default or pass `--vault` on each command.

## Steps

1. Initialize a vault and create a topic.
2. Install a connector and ingest one source.
3. Compile a proposal with a local agent.
4. Preview and approve selected wiki paths.
5. Search the index and sketch a cited query.

## Initialize and create a topic

PowerShell:

```powershell
sheldon init C:\knowledge\sheldon
sheldon topic create "Learning" --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon init ~/knowledge/sheldon
sheldon topic create "Learning" --vault ~/knowledge/sheldon
```

## Ingest one source

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

Note the source id and normalized path from the JSON output (typically `raw/<source-id>/content.md`). URL ingest works the same way with `sheldon ingest url …`.

## Compile with an agent

Confirm the agent first, then compile.

```sh
sheldon agent doctor
```

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

## Preview and approve

PowerShell:

```powershell
sheldon review preview topic learning proposal-article --vault C:\knowledge\sheldon
sheldon review approve topic learning proposal-article wiki/practical-ideas.md `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon review preview topic learning proposal-article --vault ~/knowledge/sheldon
sheldon review approve topic learning proposal-article wiki/practical-ideas.md \
  --vault ~/knowledge/sheldon
```

## Search and query

PowerShell:

```powershell
sheldon search "retrieval practice" --topic learning --vault C:\knowledge\sheldon
sheldon query topic learning answer-retrieval `
  --question "What does this vault say about retrieval practice?" `
  --agent codex `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon search "retrieval practice" --topic learning --vault ~/knowledge/sheldon
sheldon query topic learning answer-retrieval \
  --question "What does this vault say about retrieval practice?" \
  --agent codex \
  --vault ~/knowledge/sheldon
```

## Next

- Shorter compile path: [Compile then review](flow-compile-review.html)
- Command details: [init](init.html), [ingest](ingest.html), [compile](compile.html), [review](review.html), [search](search.html), [query](query.html)
- Back to [Sheldon help](../index.html)
