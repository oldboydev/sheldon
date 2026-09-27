# agent

Check whether locally installed agent CLIs (Codex, Claude, and/or Grok) are present and usable. Sheldon never calls model APIs directly; compile and query invoke these optional agent tools on your machine.

## Synopsis

```text
sheldon agent doctor [agent]
```

`agent` is optional: `codex`, `claude`, or `grok`. Omit it to check all supported agents.

## Important flags / arguments

- `agent` — optional single agent kind to probe. Must be one of the supported kinds when provided.

## Examples

Check every supported agent (portable):

```sh
sheldon agent doctor
```

Check one agent (portable):

```sh
sheldon agent doctor codex
sheldon agent doctor claude
sheldon agent doctor grok
```

## Expected outputs / artifacts

- Prints a report for each probed agent: `not found` (with recovery) or `available` (version when known), plus Authentication `usable` or `unavailable`.
- Doctor is a report: exit status stays zero even when an agent is missing or unusable.
- `compile` and `query` still need `--agent` plus a usable CLI; a green or empty doctor line does not substitute for that.
- Does not install agents or write vault files.

## Common failures

- Unknown agent name — use `codex`, `claude`, or `grok`.
- Agent binary missing from `PATH` — install that vendor’s CLI and re-run.
- Installed but not logged in — complete the agent’s own authentication flow, then retry `agent doctor`.
- Compile/query still failing after a green doctor — confirm you passed the same `--agent` value and that the vault path is correct (`--vault` or the saved default; Sheldon does **not** list vaults).

Related: [compile](compile.html), [query](query.html), [doctor](doctor.html).
