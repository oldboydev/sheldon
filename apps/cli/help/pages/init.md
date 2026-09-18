# init

Create a Sheldon vault and save it as the local default for later commands.

## Synopsis

```text
sheldon init [path] [--yes]
```

## Arguments and flags

- `path` — optional vault directory. When omitted, Sheldon proposes `~/Documents/Sheldon` and asks for confirmation.
- `--yes` — accept the proposed default path without a prompt (useful in scripts).

## Examples

PowerShell:

```powershell
sheldon init C:\knowledge\sheldon
sheldon init --yes
```

Unix:

```sh
sheldon init ~/knowledge/sheldon
sheldon init --yes
```

## Expected result

- Creates the vault layout at the chosen path.
- Writes the local config so later commands can omit `--vault`.
- Prints `Vault initialized: <path>`.

## Common failures

- Path already contains a vault or conflicting files — choose a new directory or clean the target.
- Confirmation declined when `path` is omitted and `--yes` is not set — re-run with an explicit path or `--yes`.

Sheldon does **not** list vaults. After `init`, either rely on the saved default or pass `--vault` explicitly. See [First vault](flow-first-vault.html).
