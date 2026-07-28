# @sheldon/search

Índice local SQLite/FTS5 reconstruível a partir dos conceitos aprovados em `wiki/`.

O vault Markdown permanece a fonte de verdade. `SearchIndex.rebuild(vaultRoot)` recria
`system/search-index.db` e expõe busca lexical e filtros de metadados para os próximos
comandos e integrações do M4.
