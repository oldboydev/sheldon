# Healthcheck

Run `sheldon mcp doctor --consumer <project-path>` after configuring a consumer or
changing its scopes. It validates the local stdio transport, all seven tools, the
vault and index, and the fail-closed scope configuration without contacting a service.
