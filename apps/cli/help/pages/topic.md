# topic

Create and manage topic knowledge spaces inside a vault. Topics group related sources, proposals, and approved wiki notes under a stable slug. Listing topics does not list vaults — Sheldon has no vault inventory; use the saved default from `init` or pass `--vault`.

## Synopsis

```text
sheldon topic create <title> [--description <text>] [--vault <path>]
sheldon topic list [--vault <path>]
sheldon topic show <slug> [--vault <path>]
sheldon topic rename <slug> <title> [--vault <path>]
sheldon topic archive <slug> [--vault <path>]
```

## Important flags / arguments

- `title` — human-readable name; `create` / `rename` derive the slug from it.
- `slug` — stable id used by ingest, compile, review, search, and query.
- `--description <text>` — optional description on create.
- `--vault <path>` — explicit vault path when the saved default is wrong or missing.

## Examples

PowerShell:

```powershell
sheldon topic create "Learning" --vault C:\knowledge\sheldon
sheldon topic list --vault C:\knowledge\sheldon
sheldon topic show learning --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon topic create "Learning" --vault ~/knowledge/sheldon
sheldon topic list --vault ~/knowledge/sheldon
sheldon topic show learning --vault ~/knowledge/sheldon
```

Rename or archive (portable):

```sh
sheldon topic rename learning "Deep Learning"
sheldon topic archive deep-learning
```

## Expected outputs / artifacts

- `create` — prints the new topic metadata (including slug) and creates the topic directory layout in the vault.
- `list` / `show` — JSON of topic metadata.
- `rename` — updates the title/slug and prints the updated record.
- `archive` — marks the topic archived without deleting its knowledge files.

## Common failures

- No configured vault — pass `--vault <path>` or run `sheldon init`. Sheldon does **not** list vaults.
- Slug already exists on create / unknown slug on show-rename-archive — pick another title or check `topic list`.
- Conflicting rename target — choose a title that yields an unused slug.

Related: [project](project.html), [First vault](flow-first-vault.html).
