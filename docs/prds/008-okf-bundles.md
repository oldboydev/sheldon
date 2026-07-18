# PRD 008 — Compilação de Bundles OKF

## Problema

A wiki pessoal contém estado, fontes e detalhes demais para ser entregue integralmente a cada projeto. É necessário gerar pacotes portáteis, mínimos e independentes do Sheldon.

## Objetivo

Compilar seleções aprovadas da wiki em bundles conformantes com Open Knowledge Format v0.1.

## Escopo

- Definição versionável de bundle por projeto ou finalidade.
- Seleção explícita de conceitos e regras de dependência.
- Transformação determinística de metadados e links.
- `index.md`, `log.md` e manifesto de build.
- Validação leniente e estrita.
- Builds reproduzíveis e diffs entre builds.

## Fora de escopo

- Usar OKF como formato de raw ou wiki interna.
- Importar bundles externos no MVP.
- Publicar bundles na internet.
- Usar LLM obrigatoriamente durante build.

## Conformidade alvo

Cada conceito gerado é Markdown UTF-8 com frontmatter YAML e `type` não vazio. O compilador inclui `title`, `description`, `resource` quando aplicável, `tags` e `timestamp`. Links são Markdown padrão e portáteis. `index.md` oferece descoberta progressiva e `log.md` registra alterações por data.

Campos adicionais de proveniência podem ser emitidos porque consumidores OKF devem tolerar extensões. O bundle declara `okf_version: "0.1"` somente onde permitido pela especificação.

## Requisitos funcionais

1. Uma definição de bundle referencia `concept_id`, não somente caminhos mutáveis.
2. Seleção pode incluir dependências diretas, recursivas com limite ou somente itens explícitos.
3. Conceitos ausentes, arquivados ou sem aprovação bloqueiam build estrito.
4. Mapeamento de caminho é estável e colisões são resolvidas deterministicamente.
5. Links internos são reescritos para os caminhos finais.
6. Link para conceito não incluído gera diagnóstico e segue política configurada: incluir, manter quebrado ou remover com aviso.
7. `index.md` é gerado por diretório quando necessário para navegação.
8. `log.md` compara o build atual com o último build conhecido.
9. O manifesto registra build, definição, conceitos, hashes e origem no vault.
10. Repetir build sem mudanças gera conteúdo idêntico, exceto campos explicitamente temporais definidos pela política.

## Critérios de aceitação

- Bundle mínimo passa pelas três regras de conformidade OKF v0.1.
- Um tipo desconhecido produz no máximo aviso no modo leniente.
- Caminhos renomeados na wiki mantêm seleção via `concept_id`.
- Build idêntico produz diff vazio.
- Bundle pode ser copiado para outro diretório e lido sem Sheldon.
- Conceitos de múltiplos tópicos são reunidos mantendo citações e links válidos.

## Dependências

- PRD 005 para conceitos aprovados.
- PRD 001 para projetos e definições.

## Riscos

- A especificação OKF v0.1 evoluir.
- Diferenças entre portabilidade de links em filesystem e GitHub.
- Bundle incluir conhecimento sensível por dependência transitiva.

## Mitigações

- Compilador e validador versionados por alvo OKF.
- Testes de links em Windows e em renderização Markdown comum.
- Preview da seleção e classificação de sensibilidade antes do build.

## Métricas de sucesso

- Percentual de builds aprovados pelo validador estrito.
- Builds reproduzíveis sem diff inesperado.
- Tamanho do bundle comparado ao vault completo.
- Diagnósticos de dependência resolvidos antes da distribuição.
