# plugin

Discover, install, test, and diagnose source plugins. Connectors such as `source.file` and `source.url` ship as plugins; install what you need before ingesting.

## Synopsis

```text
sheldon plugin install <id>
sheldon plugin remove <id>
sheldon plugin list [--remote]
sheldon plugin info <id> [--remote]
sheldon plugin doctor <id>
sheldon plugin test <directory>
```

## Important flags / arguments

- `id` — plugin id from the local install set or the signed official catalog (for example `source.file`).
- `--remote` — (`list` / `info`) load the signed official catalog instead of only local installs.
- `directory` — (`test`) path to a local plugin package under contract test.

## Examples

List installed plugins and the remote catalog (portable):

```sh
sheldon plugin list
sheldon plugin list --remote
sheldon plugin info source.file --remote
```

Install and health-check (portable):

```sh
sheldon plugin install source.file
sheldon plugin doctor source.file
```

PowerShell — contract-test a local plugin directory:

```powershell
sheldon plugin test C:\src\my-plugin
```

Unix:

```sh
sheldon plugin test ~/src/my-plugin
```

Remove when no longer needed (portable):

```sh
sheldon plugin remove source.file
```

## Expected outputs / artifacts

- `list` / `info` — plugin ids, versions, and install status (local and/or catalog).
- `install` — downloads a verified catalog entry into the application plugin store.
- `doctor` — healthcheck result for one installed plugin (exit non-zero when unhealthy).
- `test` — contract-test report for a local plugin directory.
- `remove` — uninstalls a non-official local plugin when allowed.

## Common failures

- Catalog signature or network failure on `--remote` / `install` — retry when online; do not bypass signature checks.
- Plugin not installed when ingesting — `plugin list --remote`, then `plugin install <id>`.
- Unhealthy doctor — follow the printed remediation (missing runtime, language pack, etc.).
- Removing an official/embedded plugin — official plugins cannot be removed; install overlays only as documented.

Related: [ingest](ingest.html), [image](image.html), [doctor](doctor.html).
