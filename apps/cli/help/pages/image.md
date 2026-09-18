# image

Manage local OCR language data used by image ingestion. Language packs are verified from the official catalog and stored outside the vault; missing languages block OCR until installed.

## Synopsis

```text
sheldon image language list
sheldon image language install <code>
sheldon image language remove <code>
```

## Important flags / arguments

- `code` — OCR language code to install or remove (for example `deu`, `eng`). Use `list` to see installed and available codes.

## Examples

List languages (portable):

```sh
sheldon image language list
```

Install and remove a language pack (portable):

```sh
sheldon image language install deu
sheldon image language remove deu
```

After languages are installed, OCR-capable ingest uses them via the image source plugin (for example with `sheldon ingest … --ocr` when that connector is installed).

## Expected outputs / artifacts

- `list` — installed and catalog-available OCR language codes.
- `install` — downloads verified language data into the local image/OCR store.
- `remove` — deletes an installed language pack from that local store.
- Does not modify vault `raw/` or `wiki/` contents by itself.

## Common failures

- Language not in catalog / signature failure — retry when online; do not bypass catalog verification.
- OCR ingest fails with language-not-installed — run `sheldon image language install <code>` for every required code.
- `source.image` unhealthy — run `sheldon plugin doctor source.image` after installing the plugin.
- Confusing language packs with vaults — language data is application state; knowledge still lives in the vault from `init` / `--vault`. Sheldon does **not** list vaults.

Related: [plugin](plugin.html), [ingest](ingest.html).
