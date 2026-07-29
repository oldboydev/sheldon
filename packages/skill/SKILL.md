---
name: sheldon
description: Consult and cite the local Sheldon knowledge vault through its scoped MCP server.
---

# Sheldon knowledge

Use Sheldon MCP when a task can benefit from approved local knowledge. Start with
`get_project_context` or `search_knowledge`, then read only the relevant concepts.
Always preserve the concept ID, wiki path, and listed raw source paths when citing an
answer. A wiki entry is useful evidence, not an uncaveated truth: check its provenance
and report uncertainty or conflicting sources.

Never request unscoped knowledge or infer access from the current repository. The MCP
server enforces the consumer project's explicit scopes. Use `read_source_excerpt` only
with a raw reference cited by a concept; it is audited. Use `file_feedback` for a
correction, insight, or coverage gap. Feedback is review input and never changes the
wiki or a raw capture.

Read the focused references when needed:

- [ingestion](references/ingestion.md)
- [compilation](references/compilation.md)
- [query](references/query.md)
- [review](references/review.md)
- [OKF](references/okf.md)
- [healthcheck](references/healthcheck.md)
