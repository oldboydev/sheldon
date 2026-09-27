# compile

Ask a locally installed agent (Codex, Claude, or Grok) to turn captured raws into a reviewable proposal. Compilation writes proposal output only — it does not change the approved wiki until you approve paths with `review`.

## Synopsis

```text
sheldon compile <kind> <slug> <proposal-id> --agent <agent> --prompt <text> --raw <path...> [--vault <path>]
sheldon compile-retry <kind> <slug> <proposal-id> --from <proposal-id> --agent <agent> --prompt <text> --raw <path...> [--vault <path>]
```

`kind` is `topic` or `project`. Agents: `codex`, `claude`, or `grok`.

## Important flags / arguments

- `proposal-id` — id for the new proposal attempt (must be a valid proposal id).
- `--agent <agent>` — which installed CLI agent should produce the proposal.
- `--prompt <text>` — task instructions for the agent.
- `--raw <path...>` — one or more raw source paths relative to the entity (for example `raw/<source-id>/content.md`).
- `--from <proposal-id>` — (`compile-retry` only) prior proposal this attempt continues from; the new id must differ.
- `--vault <path>` — explicit vault path when needed.

## Examples

PowerShell:

```powershell
sheldon compile topic learning proposal-article `
  --agent codex `
  --prompt "Extract practical ideas and write concise notes with sources." `
  --raw raw/<source-id>/content.md `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon compile topic learning proposal-article \
  --agent codex \
  --prompt "Extract practical ideas and write concise notes with sources." \
  --raw raw/<source-id>/content.md \
  --vault ~/knowledge/sheldon
```

Retry after a weak first attempt (portable):

```sh
sheldon compile-retry topic learning proposal-article-2 \
  --from proposal-article \
  --agent claude \
  --prompt "Tighten the notes; keep citations to the same raws." \
  --raw raw/<source-id>/content.md
```

Check agent readiness anytime with `sheldon agent doctor`.

## Expected outputs / artifacts

- Prints JSON for the agent run / stored proposal.
- Writes under the entity: `outputs/proposals/<proposal-id>/`.
- Leaves `wiki/` unchanged until `sheldon review approve`.

## Common failures

- Agent not installed or not logged in — run `sheldon agent doctor` and complete the agent’s own login/auth flow.
- Raw path missing or outside `raw/` — ingest first, then pass paths relative to the entity (for example `raw/<source-id>/content.md`).
- No configured vault — pass `--vault <path>` or run `sheldon init`.
- Invalid or duplicate retry id — choose a new `proposal-id` different from `--from`.

Next: [review](review.html) or the [Compile then review](flow-compile-review.html) flow.
