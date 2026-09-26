# doctor

Check vault layout, operational SQLite, and whether Codex, Claude, and Grok CLIs are on `PATH`. Doctor is a read-only health report; it does not repair or migrate state. Plugin health is `sheldon plugin doctor`; agent login detail is `sheldon agent doctor`.

## Synopsis

```text
sheldon doctor [--vault <path>]
```

## Important flags / arguments

- `--vault <path>` — explicit vault path when the saved default is wrong or missing.

## Examples

PowerShell:

```powershell
sheldon doctor --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon doctor --vault ~/knowledge/sheldon
```

Using the saved default from `init` (portable):

```sh
sheldon doctor
```

## Expected outputs / artifacts

- Prints Node.js version, `Vault: healthy`, SQLite healthy or missing (rebuildable without losing vault files), and Codex/Claude/Grok available or `not found (warning)`.
- Does not print the vault path or any plugin inventory.
- Exit status is non-zero when required checks fail (vault discovery or unreadable operational SQLite). Missing agent CLIs are warnings, not failures.
- Does not modify vault files or install missing tools.

## Common failures

- No configured vault — pass `--vault <path>` or run `sheldon init`. Sheldon does **not** list vaults.
- Unreadable operational SQLite — follow the printed recovery; vault knowledge files are preserved.
- Agent CLI missing or not logged in — `sheldon doctor` only warns about `PATH`; run `sheldon agent doctor` for install/auth detail.
- Plugin issues — use `sheldon plugin doctor <id>` / `sheldon plugin install <id>`; they are not part of this report.
- Corrupt or incomplete vault layout — re-init into a clean directory or restore from backup; do not invent a vault list.

Related: [agent](agent.html), [plugin](plugin.html), [migrate-state](migrate-state.html).
