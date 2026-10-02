# image

Manage extra OCR language data used by `source.image`. Install that plugin first. Base packs `por` and `eng` ship with the plugin and cannot be removed. Extra codes such as `deu` come from the official catalog and are stored outside the vault. The official catalog publishes `source.image` (and its extra language packs) for Windows x64 and Linux x64 only.

## Synopsis

```text
sheldon image language list
sheldon image language install <code>
sheldon image language remove <code>
```

## Important flags / arguments

- Install `source.image` first — `list`, `install`, and `remove` all look up that installed plugin.
- `code` — extra OCR language code to install or remove (for example `deu`). Never pass `eng` or `por` to `remove`.
- `list` is local: base `por` / `eng` plus extras already on the installed plugin root. It does not print the remote catalog.

## Examples

Install the plugin, then list local languages (portable):

```sh
sheldon plugin install source.image
sheldon image language list
```

Install and remove an extra language pack (portable):

```sh
sheldon image language install deu
sheldon image language remove deu
```

Local image files use `sheldon ingest file … --plugin source.image` (the plugin runs OCR). `ingest file` has no `--ocr` flag. URL ingest can add `--media images --ocr` when `source.image` is installed.

## Expected outputs / artifacts

- `list` — local codes only: `por` and `eng` as `base`, plus extras from the installed plugin root (not the remote catalog).
- `install` — downloads a catalog extra language into the local image/OCR store.
- `remove` — deletes an extra installed language pack from that store (`deu`; not `eng` or `por`).
- Does not modify vault `raw/` or `wiki/` contents by itself.

## Common failures

- `source.image` not installed — `sheldon plugin install source.image`, then retry. On macOS the official catalog marks this plugin `platform unavailable`.
- Language not in catalog / signature failure — retry when online; do not bypass catalog verification.
- Removing `eng` or `por` — those are base packs; use an extra code such as `deu`.
- OCR ingest fails with language-not-installed — run `sheldon image language install <code>` for every extra required code.
- `source.image` unhealthy — run `sheldon plugin doctor source.image` after installing the plugin.
- Confusing language packs with vaults — language data is application state; knowledge still lives in the vault from `init` / `--vault`. Sheldon does **not** list vaults.

Related: [plugin](plugin.html), [ingest](ingest.html).
