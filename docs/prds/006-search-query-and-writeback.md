# PRD 006 — Busca, Consulta e Write-back

## Problema

Uma wiki só gera valor quando o usuário e os agentes conseguem localizar conhecimento relevante, sintetizar respostas rastreáveis e devolver aprendizados duráveis ao corpus.

## Objetivo

Entregar busca local, consultas por Codex ou Claude com citações e um fluxo controlado de write-back.

## Escopo

- Índice local reconstruível.
- Busca lexical e por metadados.
- Navegação por links e backlinks.
- Consulta orientada pelo índice da wiki.
- Respostas salvas como outputs.
- Promoção de síntese durável para proposta.
- Identificação explícita de lacunas.

## Fora de escopo

- Banco vetorial remoto.
- Respostas baseadas em conhecimento geral sem marcar a ausência na wiki.
- Alteração automática da wiki após consulta.

## Requisitos funcionais

1. O índice cobre título, descrição, aliases, tags, corpo, fontes e caminhos.
2. Busca oferece filtros por tópico, projeto, tipo, tag, data e status.
3. Resultados incluem snippet, score, origem do match e conceitos relacionados.
4. O índice é descartável e reconstruível a partir do vault.
5. Consultas começam por índices e busca, leem conceitos selecionados e seguem no máximo a profundidade configurada de links.
6. A resposta cita conceitos e distingue fatos da wiki, inferências e lacunas.
7. Quando necessário, o agente pode abrir raws citados para verificar ambiguidade.
8. Respostas salvas registram pergunta, agente, conceitos, raws, timestamp e texto final.
9. Uma resposta durável pode virar proposta, passando pelo PRD 004.
10. Consultas puramente lexicais não executam Codex ou Claude.

## Critérios de aceitação

- Busca encontra aliases e termos exatos sem modelo de embedding.
- Filtros não retornam conteúdo fora do tópico ou projeto solicitado.
- Apagar e reconstruir o índice preserva resultados equivalentes.
- Uma pergunta sem cobertura retorna lacuna explícita e sugestões de fontes, sem fabricar resposta da wiki.
- Uma resposta cruzando conceitos contém citações para cada conclusão material.
- Salvar e promover uma resposta não altera a wiki antes da revisão.

## Dependências

- PRD 005 para wiki e índices conceituais.
- PRD 004 para consultas por agente e propostas de promoção.

## Riscos

- Busca lexical perder sinônimos ou linguagem vaga.
- Contexto excessivo enviado ao agente.
- Resposta citar conceito que não sustenta a afirmação.

## Mitigações

- Aliases, expansão local de termos e navegação por links.
- Orçamento de contexto e seleção progressiva.
- Validação de citações e opção de verificar raws.

## Métricas de sucesso

- Precisão percebida dos primeiros resultados em conjunto de consultas de referência.
- Percentual de afirmações de respostas com citação válida.
- Tamanho médio do contexto enviado ao CLI.
- Taxa de outputs promovidos para propostas aprovadas.
