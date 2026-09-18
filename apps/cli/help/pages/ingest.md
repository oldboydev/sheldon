# ingest

Capture sources into immutable local raw records under a topic or project. Ingestion never changes the approved wiki — it only publishes originals and normalized content for later compile and review. Source connectors are plugins; install the ones you need before ingesting.

## Synopsis

```text
sheldon ingest file <kind> <slug> <file> [--plugin <id>] [--vault <path>]
sheldon ingest url <kind> <slug> <url> [--plugin <id>] [--language <tags>] [--cookies <path>] [--media <mode>] [--ocr] [--stt] [--vault <path>]
sheldon ingest crawl <kind> <slug> <seed-url> --max-pages <1-10> --max-depth <0-2> [--plugin <id>] [--vault <path>]
sheldon ingest repository <kind> <slug> <directory> [--plugin <id>] [--vault <path>]
```

`kind` is `topic` or `project`. `slug` identifies the knowledge space inside the vault.

## Important flags / arguments

- `file` / `url` / `seed-url` / `directory` — the source to capture.
- `--plugin <id>` — force a specific ingestion plugin when more than one matches (or to override auto-selection).
- `--max-pages` / `--max-depth` — required bounds for `ingest crawl` (pages 1–10, depth 0–2).
- `--language <tags>` — preferred comma-separated language tags for URL capture.
- `--cookies <path>` — optional local cookie file for URL ingest (never stored in the vault).
- `--media <mode>` — social media capture: `none`, `thumbnail`, or `images`.
- `--ocr` — derive local OCR from explicitly downloaded image assets.
- `--stt` — allow an already-installed local speech-to-text runtime (may download temporary audio).
- `--vault <path>` — explicit vault path when the saved default is wrong or missing.

## Examples

List and install connectors first:

```powershell
sheldon plugin list
sheldon plugin list --remote
sheldon plugin install source.file
```

PowerShell — local file:

```powershell
sheldon ingest file topic learning C:\inbox\article.pdf --vault C:\knowledge\sheldon
```

Unix — local file:

```sh
sheldon ingest file topic learning ~/inbox/article.pdf --vault ~/knowledge/sheldon
```

Public URL (portable):

```sh
sheldon ingest url topic learning https://example.com/article --vault ~/knowledge/sheldon
```

Bounded crawl (portable):

```sh
sheldon ingest crawl topic learning https://example.com/docs --max-pages 5 --max-depth 1
```

Local Git repository snapshot:

PowerShell:

```powershell
sheldon ingest repository topic learning C:\src\my-repo --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon ingest repository topic learning ~/src/my-repo --vault ~/knowledge/sheldon
```

## Expected outputs / artifacts

- Prints JSON describing the published source (including source id and normalized paths).
- Writes immutable capture under the entity: `raw/<source-id>/` (original plus normalized content such as `content.md`).
- Does not create proposals or modify `wiki/`.

## Common failures

- Required plugin not installed — run `sheldon plugin list --remote`, then `sheldon plugin install <id>` (for example `source.file` or `source.url`).
- Ambiguous plugin selection — retry with `--plugin <id>` using one of the listed candidates.
- No configured vault — pass `--vault <path>` or run `sheldon init`.
- Unreadable input path / invalid URL / dirty Git working tree (repository) — fix the input and retry.
- Topic or project slug missing — create it with `sheldon topic create` / `sheldon project create` first.

See [Compile then review](flow-compile-review.html) for turning raws into approved wiki notes.
