# bundle

Create, compile, validate, and compare local portable OKF bundles from approved wiki concepts. Bundles package a selected concept set for reuse; they do not replace review or change the live wiki by themselves.

## Synopsis

```text
sheldon bundle create <bundle-id> --concept <concept-id...> [--title <title>] [--description <description>] [--dependencies <mode>] [--max-depth <depth>] [--unresolved-link <policy>] [--vault <path>]
sheldon bundle build <bundle-id> [--mode <strict|lenient>] [--apply] [--vault <path>]
sheldon bundle validate <directory> [--mode <strict|lenient>]
sheldon bundle diff <previous-directory> <next-directory>
```

## Important flags / arguments

- `bundle-id` — id for the bundle definition under the vault.
- `--concept <concept-id...>` — (`create`) one or more stable approved concept ids; repeat as needed.
- `--dependencies <mode>` — `explicit` (default), `direct`, or `recursive`.
- `--max-depth <depth>` — only with `--dependencies recursive` (1–32).
- `--unresolved-link <policy>` — `include` (default), `keep-broken`, or `remove-warning`.
- `--mode <mode>` — (`build` / `validate`) `strict` (default) or `lenient`.
- `--apply` — (`build`) write the previewed portable bundle after selection review.
- `--vault <path>` — explicit vault path when needed.
- `directory` / `previous-directory` / `next-directory` — compiled bundle directories on disk.

## Examples

PowerShell — define then build:

```powershell
sheldon bundle create learning-core `
  --concept concept.retrieval-practice `
  --title "Learning core" `
  --vault C:\knowledge\sheldon
sheldon bundle build learning-core --vault C:\knowledge\sheldon
sheldon bundle build learning-core --apply --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon bundle create learning-core \
  --concept concept.retrieval-practice \
  --title "Learning core" \
  --vault ~/knowledge/sheldon
sheldon bundle build learning-core --vault ~/knowledge/sheldon
sheldon bundle build learning-core --apply --vault ~/knowledge/sheldon
```

Validate and diff compiled directories (portable):

```sh
sheldon bundle validate ./bundles/learning-core
sheldon bundle diff ./bundles/learning-core-v1 ./bundles/learning-core-v2
```

## Expected outputs / artifacts

- `create` — writes a bundle definition under the vault (`bundles/…`) without exporting files yet.
- `build` without `--apply` — selection/preview output only.
- `build --apply` — writes the portable compiled bundle directory.
- `validate` — manifest and content validation report.
- `diff` — comparison of two compiled bundle directories.

## Common failures

- Concept id not approved or unknown — approve wiki notes first; pass stable concept ids from the vault.
- `--max-depth` without `--dependencies recursive` — remove `--max-depth` or switch dependency mode.
- Build preview only — add `--apply` after reviewing the selection.
- No configured vault — pass `--vault <path>` or run `sheldon init`. Sheldon does **not** list vaults.

Related: [mcp](mcp.html), [review](review.html), [search](search.html).
