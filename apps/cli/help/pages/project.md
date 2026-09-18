# project

Create and manage project knowledge spaces inside a vault. Projects are the sibling of topics: same CRUD surface, used when knowledge is scoped to a product or effort rather than a subject area. Like topics, project commands never list vaults — only the saved default and `--vault` select which vault to use.

## Synopsis

```text
sheldon project create <title> [--description <text>] [--vault <path>]
sheldon project list [--vault <path>]
sheldon project show <slug> [--vault <path>]
sheldon project rename <slug> <title> [--vault <path>]
sheldon project archive <slug> [--vault <path>]
```

## Important flags / arguments

- `title` — human-readable name; `create` / `rename` derive the slug from it.
- `slug` — stable id used by ingest, compile, review, search, and query with `kind=project`.
- `--description <text>` — optional description on create.
- `--vault <path>` — explicit vault path when needed.

## Examples

PowerShell:

```powershell
sheldon project create "Sheldon CLI" --description "CLI product notes" --vault C:\knowledge\sheldon
sheldon project list --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon project create "Sheldon CLI" --description "CLI product notes" --vault ~/knowledge/sheldon
sheldon project list --vault ~/knowledge/sheldon
```

Show, rename, archive (portable):

```sh
sheldon project show sheldon-cli
sheldon project rename sheldon-cli "Sheldon Desktop"
sheldon project archive sheldon-desktop
```

## Expected outputs / artifacts

- `create` — prints project metadata (including slug) and creates the project directory layout.
- `list` / `show` — JSON of project metadata.
- `rename` / `archive` — update metadata without deleting knowledge files.

## Common failures

- No configured vault — pass `--vault <path>` or run `sheldon init`. Sheldon does **not** list vaults.
- Slug collision or unknown slug — use `project list` and adjust the title/slug.
- Wrong kind later in ingest/compile — pass `project` (not `topic`) with this slug.

Related: [topic](topic.html), [ingest](ingest.html).
