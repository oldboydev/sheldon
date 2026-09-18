# query

Ask an agent a cited question using approved indexed knowledge. Query selects context from the local index first, then runs Codex, Claude, or Grok; it saves the answer without modifying wiki files.

## Synopsis

```text
sheldon query <kind> <slug> <answer-id> --question <text> --agent <agent> [--link-depth <0-2>] [--max-context-chars <n>] [--rebuild] [--vault <path>]
```

`kind` is `topic` or `project`. Agents: `codex`, `claude`, or `grok`.

## Important flags / arguments

- `answer-id` — id used when saving the answer under the entity.
- `--question <text>` — required question answered from indexed wiki context.
- `--agent <agent>` — agent that writes the cited answer.
- `--link-depth <depth>` — maximum local wiki-link expansion (0–2; default 1).
- `--max-context-chars <n>` — maximum characters of selected concept records (1000–200000; default 24000).
- `--rebuild` — rebuild the disposable local index before selecting context.
- `--vault <path>` — explicit vault path when needed.

## Examples

PowerShell:

```powershell
sheldon query topic learning answer-retrieval `
  --question "What does this vault say about retrieval practice?" `
  --agent codex `
  --vault C:\knowledge\sheldon
```

Unix:

```sh
sheldon query topic learning answer-retrieval \
  --question "What does this vault say about retrieval practice?" \
  --agent codex \
  --vault ~/knowledge/sheldon
```

## Expected outputs / artifacts

- Prints the saved answer JSON (question, citations, gaps, final text).
- Writes `outputs/answers/<answer-id>/answer.json` under the entity.
- Does not change `wiki/`; durable write-back goes through [answer](answer.html) promote → [review](review.html).

## Common failures

- Agent not installed or not logged in — run `sheldon agent doctor` and authenticate the chosen agent.
- Thin or empty index — approve wiki notes first; use `--rebuild` if needed.
- No configured vault — pass `--vault <path>` or run `sheldon init`.
- Explicit coverage gaps — the command may save an uncovered answer with gap notes instead of inventing wiki facts.

Promote a durable synthesis with [answer](answer.html).
