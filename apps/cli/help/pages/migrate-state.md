# migrate-state

Copy legacy Sheldon plugin/application state into this platform’s state directory after hash verification. Use this when upgrading from an older layout that kept state under a different application-data path. It does not move or rewrite vault knowledge files.

## Synopsis

```text
sheldon migrate-state --from <directory>
```

## Important flags / arguments

- `--from <directory>` — required path to the legacy Sheldon application-state directory to copy from.
- Target directory is chosen by the current platform state root (not a vault path).

## Examples

PowerShell:

```powershell
sheldon migrate-state --from "$env:LOCALAPPDATA\Sheldon"
```

Unix:

```sh
sheldon migrate-state --from ~/.local/share/Sheldon
```

Adjust `--from` to the actual legacy state directory on your machine.

## Expected outputs / artifacts

- Verifies hashes, then copies eligible plugin/application state into the current platform state root.
- Prints `Plugin state migrated to: <target>`.
- Leaves vault contents (`raw/`, `wiki/`, proposals) untouched.

## Common failures

- `--from` missing or not a directory — pass the real legacy state path.
- Hash verification failure — stop; do not force a partial copy; restore a known-good legacy state and retry.
- Permission denied on source or target — fix filesystem permissions and re-run.
- Already migrated / empty source — confirm the legacy path before retrying.

This command is about application state, not vault discovery. Sheldon does **not** list vaults; knowledge stays at the path from `init` or `--vault`.

Related: [doctor](doctor.html), [plugin](plugin.html).
