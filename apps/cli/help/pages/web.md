# web

Start the local Sheldon web interface on loopback only (`127.0.0.1`). The UI never binds a public interface; stop it with Ctrl+C when finished.

## Synopsis

```text
sheldon web [--vault <path>] [--port <port>]
```

## Important flags / arguments

- `--vault <path>` — explicit vault path when the saved default is wrong or missing.
- `--port <port>` — loopback port (0–65535). Omit to let Sheldon pick a free port.

## Examples

PowerShell:

```powershell
sheldon web --vault C:\knowledge\sheldon
sheldon web --vault C:\knowledge\sheldon --port 8787
```

Unix:

```sh
sheldon web --vault ~/knowledge/sheldon
sheldon web --vault ~/knowledge/sheldon --port 8787
```

Using the saved default (portable):

```sh
sheldon web
```

## Expected outputs / artifacts

- Prints `Sheldon web: http://127.0.0.1:<port>` and a reminder that access is loopback-only.
- Serves the local UI until you press Ctrl+C.
- Does not expose the vault on the LAN or internet.
- **Revisão** lists topics that currently have a pending proposal, then the pending proposals of
  the chosen topic. **Abrir revisão** renders the proposed wiki page (YAML frontmatter stripped)
  with a compact per-file diff; approve still writes only the selected wiki paths. Compile from
  the CLI does not fill the job list — pick the proposal from the pending list.

## Common failures

- No configured vault — pass `--vault <path>` or run `sheldon init`. Sheldon does **not** list vaults.
- Port already in use — omit `--port` for an automatic free port, or choose another value.
- Browser cannot reach a non-loopback URL — open the printed `127.0.0.1` address only; do not put a reverse proxy in front.

Related: [init](init.html), [First vault](flow-first-vault.html), [review](review.html),
[Compile then review](flow-compile-review.html).
