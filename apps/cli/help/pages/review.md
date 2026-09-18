# review

Preview, approve, reject, and lint proposed wiki changes. Review is the only path that applies selected proposal files into the approved wiki; ingest and compile never publish wiki notes on their own.

## Synopsis

```text
sheldon review preview <kind> <slug> <proposal-id> [--vault <path>]
sheldon review approve <kind> <slug> <proposal-id> <paths...> [--vault <path>]
sheldon review reject <kind> <slug> <proposal-id> --reason <text> [--vault <path>]
sheldon review lint <kind> <slug> [--vault <path>]
```

`kind` is `topic` or `project`.

## Important flags / arguments

- `proposal-id` — proposal produced by `compile`, `compile-retry`, or `answer promote`.
- `paths...` — (`approve`) one or more proposal file paths to apply (for example `wiki/practical-ideas.md`).
- `--reason <text>` — (`reject`) required non-empty rejection reason.
- `--vault <path>` — explicit vault path when needed.

## Examples

PowerShell:

```powershell
sheldon review preview topic learning proposal-article --vault C:\knowledge\sheldon
sheldon review approve topic learning proposal-article wiki/practical-ideas.md `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon review preview topic learning proposal-article --vault ~/knowledge/sheldon
sheldon review approve topic learning proposal-article wiki/practical-ideas.md \
  --vault ~/knowledge/sheldon
```

Reject or lint (portable):

```sh
sheldon review reject topic learning proposal-article --reason "Too broad; retry with a narrower prompt."
sheldon review lint topic learning
```

## Expected outputs / artifacts

- `preview` — JSON listing proposed file changes without writing wiki.
- `approve` — applies only the selected paths into `wiki/` and prints the approval result JSON.
- `reject` — records rejection metadata for the proposal; further approve attempts fail.
- `lint` — JSON report of approved wiki structure, links, and sources.

Proposal files live under `outputs/proposals/<proposal-id>/`.

## Common failures

- Proposal missing or already rejected — compile a new attempt (`compile` / `compile-retry`) or pick another id.
- Path not in the proposal — preview first, then approve exact paths from that listing.
- No configured vault — pass `--vault <path>` or run `sheldon init`.
- Empty `--reason` on reject — supply a non-empty reason.

See [Compile then review](flow-compile-review.html) for the end-to-end raw → approve path.
