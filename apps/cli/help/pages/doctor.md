# doctor

Check the vault layout, local databases, installed plugins, and agent tool availability. Doctor is a read-only health report for the current environment; it does not repair or migrate state by itself.

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

- Prints a structured health report (vault path, databases, plugins, agent CLIs).
- Exit status is non-zero when required checks fail.
- Does not modify vault files or install missing tools.

## Common failures

- No configured vault — pass `--vault <path>` or run `sheldon init`. Sheldon does **not** list vaults.
- Missing or unhealthy plugin — install or diagnose with `sheldon plugin install` / `sheldon plugin doctor <id>`.
- Agent CLI missing or not logged in — run `sheldon agent doctor` and complete that agent’s auth flow.
- Corrupt or incomplete vault layout — re-init into a clean directory or restore from backup; do not invent a vault list.

Related: [agent](agent.html), [plugin](plugin.html), [migrate-state](migrate-state.html).
