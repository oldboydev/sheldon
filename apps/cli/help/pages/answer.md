# answer

Turn saved query answers into reviewable knowledge proposals. Promotion runs an agent against the answer’s evidence and writes proposal output only — the approved wiki still changes only after `review approve`.

## Synopsis

```text
sheldon answer promote <kind> <slug> <answer-id> <proposal-id> --prompt <text> [--vault <path>]
```

`kind` is `topic` or `project`.

## Important flags / arguments

- `answer-id` — previously saved answer from `sheldon query`.
- `proposal-id` — id for the new proposal.
- `--prompt <text>` — instruction for the durable wiki change the agent should propose.
- `--vault <path>` — explicit vault path when needed.

The agent kind comes from the saved answer (the agent used for `query`).

## Examples

PowerShell:

```powershell
sheldon answer promote topic learning answer-retrieval proposal-from-answer `
  --prompt "Add a concise wiki note summarizing retrieval practice with citations." `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon answer promote topic learning answer-retrieval proposal-from-answer \
  --prompt "Add a concise wiki note summarizing retrieval practice with citations." \
  --vault ~/knowledge/sheldon
```

Then preview and approve as usual:

```sh
sheldon review preview topic learning proposal-from-answer
sheldon review approve topic learning proposal-from-answer wiki/retrieval-practice.md
```

## Expected outputs / artifacts

- Prints JSON for the stored pending proposal.
- Writes `outputs/proposals/<proposal-id>/` linked to evidence from `outputs/answers/<answer-id>/`.
- Does not modify `wiki/` until review approval.

## Common failures

- Answer missing or not promotable — run `query` first; answers without raw evidence cannot be promoted.
- Agent unavailable for the saved answer’s agent kind — run `sheldon agent doctor`.
- Proposal references raws outside the answer evidence — adjust the prompt or re-query with broader context.
- No configured vault — pass `--vault <path>` or run `sheldon init`.

Related: [query](query.html), [review](review.html).
