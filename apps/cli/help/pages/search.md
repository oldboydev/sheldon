# search

Search approved wiki concepts in the disposable local index. Search is lexical and filterable; it does not call an agent and does not modify the vault.

## Synopsis

```text
sheldon search <query> [--topic <slug>] [--project <slug>] [--type <type>] [--tag <tag>] [--status <status>] [--updated-after <timestamp>] [--updated-before <timestamp>] [--rebuild] [--vault <path>]
```

## Important flags / arguments

- `query` — search text matched against indexed concept fields.
- `--topic` / `--project` — restrict results to one knowledge space.
- `--type` / `--tag` / `--status` — metadata filters.
- `--updated-after` / `--updated-before` — ISO-8601 instant bounds on concept updates.
- `--rebuild` — rebuild the disposable local index before searching.
- `--vault <path>` — explicit vault path when needed.

## Examples

PowerShell:

```powershell
sheldon search "retrieval practice" --topic learning --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon search "retrieval practice" --topic learning --vault ~/knowledge/sheldon
```

Rebuild then search (portable):

```sh
sheldon search "spaced repetition" --rebuild
```

## Expected outputs / artifacts

- Prints JSON search hits (snippets, scores, related concepts) to stdout.
- May create or refresh the disposable SQLite search index under the vault; that index is rebuildable and is not the source of truth.

## Common failures

- Empty or unexpected results — approve wiki content first; try `--rebuild` if the index is stale.
- No configured vault — pass `--vault <path>` or run `sheldon init`.
- Filters too narrow — drop `--topic` / `--tag` / date bounds and broaden the query.

For agent-cited answers over the same index, see [query](query.html).
