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
- `--ocr` — (`ingest url` only) derive local OCR from downloaded image assets; requires `--media images` and installed `source.image`. `ingest file` has no `--ocr` flag.
- `--stt` — (`ingest url` only) allow an already-installed local speech-to-text runtime (may download temporary audio).
- `--vault <path>` — explicit vault path when the saved default is wrong or missing.

## Examples

List and install connectors first:

```powershell
sheldon plugin list
sheldon plugin list --remote
sheldon plugin install source.file
sheldon plugin install source.image
sheldon plugin install source.url
sheldon plugin install source.youtube
sheldon plugin install source.instagram
sheldon plugin install source.linkedin
sheldon plugin install source.repository
```

On macOS the official catalog does not ship `source.image`, `source.youtube`, or `source.instagram`. `plugin list --remote` shows `platform unavailable` for those ids; install `source.file`, `source.url`, `source.linkedin`, or `source.repository` from the catalog. Image, YouTube, and Instagram capture remain available from the catalog on Windows and Linux.

PowerShell — local file:

```powershell
sheldon ingest file topic learning C:\inbox\article.pdf --vault C:\knowledge\sheldon
```

Unix — local file:

```sh
sheldon ingest file topic learning ~/inbox/article.pdf --vault ~/knowledge/sheldon
```

PowerShell — local image file (OCR via `source.image`):

```powershell
sheldon ingest file topic learning C:\inbox\scan.png --plugin source.image --vault C:\knowledge\sheldon
```

Unix — local image file (OCR via `source.image`):

```sh
sheldon ingest file topic learning ~/inbox/scan.png --plugin source.image --vault ~/knowledge/sheldon
```

PowerShell — public URL:

```powershell
sheldon ingest url topic learning https://example.com/article --vault C:\knowledge\sheldon
```

Unix — public URL:

```sh
sheldon ingest url topic learning https://example.com/article --vault ~/knowledge/sheldon
```

PowerShell — YouTube video (`source.youtube`, caption language preference):

```powershell
sheldon ingest url topic learning https://www.youtube.com/watch?v=xxxxxxxxxxx --plugin source.youtube --language pt,en --vault C:\knowledge\sheldon
```

Unix — YouTube video:

```sh
sheldon ingest url topic learning https://www.youtube.com/watch?v=xxxxxxxxxxx --plugin source.youtube --language pt,en --vault ~/knowledge/sheldon
```

PowerShell — Instagram Reel (`source.instagram`; cookies, media; add `--stt` only when a local
speech runtime is already installed):

```powershell
sheldon ingest url topic learning https://www.instagram.com/reel/SHORTCODE/ --plugin source.instagram --cookies C:\secrets\instagram-cookies.txt --media thumbnail --vault C:\knowledge\sheldon
```

Unix — Instagram Reel:

```sh
sheldon ingest url topic learning https://www.instagram.com/reel/SHORTCODE/ --plugin source.instagram --cookies ~/secrets/instagram-cookies.txt --media thumbnail --vault ~/knowledge/sheldon
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

- Required plugin not installed — run `sheldon plugin list --remote`, then `sheldon plugin install <id>` (for example `source.file`, `source.image`, `source.url`, `source.youtube`, `source.instagram`, `source.linkedin`, or `source.repository`). On macOS, `source.image`, `source.youtube`, and `source.instagram` are `platform unavailable` in the official catalog.
- Ambiguous plugin selection — retry with `--plugin <id>` using one of the listed candidates.
- No configured vault — pass `--vault <path>` or run `sheldon init`.
- Unreadable input path / invalid URL / dirty Git working tree (repository) — fix the input and retry.
- Topic or project slug missing — create it with `sheldon topic create` / `sheldon project create` first.

See [Compile then review](flow-compile-review.html) for turning raws into approved wiki notes.
