# PRD 005 — Compilação e Qualidade da Wiki

## Problema

Resumos isolados não formam um segundo cérebro. O sistema precisa integrar fontes a conceitos existentes, manter links e proveniência, revelar contradições e impedir deterioração estrutural.

## Objetivo

Definir como agentes propõem conhecimento durável e como validadores determinísticos mantêm a wiki coerente.

## Escopo

- Schema de conceitos e índices.
- Criação e atualização de páginas atômicas.
- Proveniência e citações obrigatórias.
- Backlinks e aliases.
- Registro de contradições, supersessão e lacunas.
- Lint estrutural e relatórios de saúde.
- Compilação incremental a partir de raws novos.

## Fora de escopo

- OKF como formato interno.
- Ontologia global rígida.
- Resolução automática de toda contradição.
- Busca vetorial.

## Modelo de conceito

Todo conceito aprovado possui identificador estável, tipo local, título, descrição, aliases, tags, timestamps, status, fontes e corpo Markdown estruturado. Tipos são definidos por tópico ou projeto e podem evoluir mediante revisão.

## Requisitos funcionais

1. Compilação começa pelo índice do tópico ou projeto e pelos raws selecionados.
2. O agente decide entre criar, atualizar, dividir ou não alterar, justificando a decisão.
3. Páginas tratam um conceito principal e permanecem dentro de limites configuráveis.
4. Toda afirmação material nova referencia ao menos um raw ou é marcada como inferência.
5. Contradições preservam as posições e fontes envolvidas.
6. Novas páginas disparam auditoria de menções e backlinks.
7. Índices são regenerados deterministicamente a partir do frontmatter.
8. Lint detecta links mortos, órfãos, fontes ausentes, schema inválido, stale content e duplicatas prováveis.
9. Correções semânticas sempre voltam como proposta; correções puramente mecânicas também ficam visíveis na revisão.
10. O histórico registra ingestão, compilação, aprovação, consulta, promoção e lint.

## Critérios de aceitação

- Uma fonte que amplia conceito existente propõe atualização, não duplicata por título similar.
- Uma fonte conflitante gera seção ou registro explícito de tensão com citações de ambos os lados.
- Criar conceito atualiza índices e sugere backlinks relevantes.
- Conceito órfão e link morto aparecem no lint.
- Remover ou mover um raw referenciado gera erro de integridade.
- Recompilar sem raws ou decisões novas não altera arquivos aprovados.

## Dependências

- PRD 003 para raws.
- PRD 004 para propostas e revisão.

## Riscos

- Wiki passar a citar a si mesma como autoridade.
- Crescimento de páginas e índices além do contexto útil.
- Tipos e tags divergirem por variações de nome.
- Excesso de revisão manual.

## Mitigações

- Raws continuam sendo a evidência primária.
- Páginas atômicas e índices hierárquicos.
- Vocabulários locais validados.
- Agrupamento de alterações mecânicas sem ocultar diffs.

## Métricas de sucesso

- Cobertura de proveniência das afirmações materiais.
- Links mortos e órfãos por cem conceitos.
- Taxa de duplicatas detectadas antes da aprovação.
- Percentual de compilações sem mudança quando a entrada é idêntica.
