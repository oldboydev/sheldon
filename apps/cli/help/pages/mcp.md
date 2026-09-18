# mcp

Configure local, scoped MCP knowledge access for a consumer project. MCP uses stdio and explicit topic/project scopes — it does not open network listeners or grant whole-vault access by default.

## Synopsis

```text
sheldon mcp configure <consumer> --vault <path> --consumer-id <id> --scope <kind:slug...> [--bundle <path>] [--apply]
sheldon mcp install-skill <consumer> [--agent <agent>] [--apply]
sheldon mcp doctor --consumer <path>
sheldon mcp serve --consumer-config <path>
```

## Important flags / arguments

- `consumer` — path to the consumer project directory.
- `--vault <path>` — (`configure`) absolute Sheldon vault path (required).
- `--consumer-id <id>` — (`configure`) stable identity for the consumer project.
- `--scope <kind:slug...>` — (`configure`) authorized scopes such as `topic:learning`; repeat as needed.
- `--bundle <path>` — (`configure`) optional bundle definition relative to `vault/bundles`.
- `--apply` — (`configure` / `install-skill`) write the previewed changes after review.
- `--agent <agent>` — (`install-skill`) `codex`, `claude`, `grok`, `both` (Codex+Claude), or `all`.
- `--consumer <path>` — (`doctor`) consumer project directory to validate.
- `--consumer-config <path>` — (`serve`) absolute path to the consumer MCP configuration file.

## Examples

PowerShell — preview then apply MCP config:

```powershell
sheldon mcp configure C:\src\app-consumer `
  --vault C:\knowledge\sheldon `
  --consumer-id app-consumer `
  --scope topic:learning
sheldon mcp configure C:\src\app-consumer `
  --vault C:\knowledge\sheldon `
  --consumer-id app-consumer `
  --scope topic:learning `
  --apply
```

Unix:

```sh
sheldon mcp configure ~/src/app-consumer \
  --vault ~/knowledge/sheldon \
  --consumer-id app-consumer \
  --scope topic:learning
sheldon mcp configure ~/src/app-consumer \
  --vault ~/knowledge/sheldon \
  --consumer-id app-consumer \
  --scope topic:learning \
  --apply
```

Install the Sheldon skill and validate (portable):

```sh
sheldon mcp install-skill ~/src/app-consumer --agent all --apply
sheldon mcp doctor --consumer ~/src/app-consumer
```

`mcp serve` is normally launched by the agent/MCP host with `--consumer-config`, not typed by hand.

## Expected outputs / artifacts

- `configure` without `--apply` — prints a preview of local client config changes (for example Codex/Claude/Grok config fragments and `.sheldon/mcp.yaml`).
- `configure --apply` — writes those local files after the same preview.
- `install-skill` — previews or copies the Sheldon skill into the chosen agent skill directories.
- `doctor` — validates the consumer’s Sheldon MCP configuration.
- `serve` — runs the scoped MCP server over stdio for one consumer.

## Common failures

- Missing required `--vault` / `--consumer-id` / `--scope` — pass absolute vault path and at least one `kind:slug` scope. Sheldon does **not** list vaults.
- Scope slug missing in the vault — create the topic/project first, then reconfigure.
- Preview-only run did nothing on disk — add `--apply` after reviewing the preview.
- Doctor failures — fix the reported consumer config paths and re-run `mcp doctor`.

Related: [bundle](bundle.html), [search](search.html), [agent](agent.html).
