# PRD 004 — Runtime de Agentes e Revisão

## Problema

Codex CLI e Claude Code oferecem interfaces diferentes. Permitir que escrevam diretamente no vault reduziria rastreabilidade e transformaria erros de síntese em conhecimento oficial.

## Objetivo

Normalizar os dois CLIs como workers substituíveis e criar um fluxo obrigatório de propostas revisáveis.

## Escopo

- Detecção e healthcheck de Codex CLI e Claude Code.
- Execução não interativa com diretórios e permissões mínimas.
- Prompts versionados e saída estruturada.
- Eventos normalizados, cancelamento e logs.
- Modelo de proposta com diffs, fontes, afirmações e contradições.
- Aprovação, edição, rejeição e nova tentativa.

## Fora de escopo

- Chamada direta às APIs OpenAI ou Anthropic.
- Gerenciamento de assinatura ou autenticação dos CLIs.
- Escolha automática baseada em preço de tokens.
- Escrita direta do agente na wiki aprovada.

## Requisitos funcionais

1. O usuário escolhe Codex ou Claude por execução e pode definir preferência por operação.
2. O runtime verifica disponibilidade e autenticação utilizável sem registrar credenciais.
3. Cada execução usa schema de saída equivalente nos dois adapters.
4. O agente recebe somente raws, índices e conceitos necessários para a tarefa.
5. A saída é rejeitada quando viola schema, referencia arquivo fora do escopo ou omite fontes obrigatórias.
6. Propostas registram agente, versão detectada, prompt, entradas, timestamps e resultado.
7. Revisão mostra diff por arquivo, fontes, novas afirmações, remoções, contradições e baixa confiança.
8. Aprovação pode ser total ou por arquivo; edição humana é registrada.
9. Rejeição aceita motivo e pode originar nova execução ligada à anterior.
10. Cancelamento nunca promove conteúdo incompleto.

## Critérios de aceitação

- A mesma fixture de tarefa produz propostas válidas por adapters falsos de ambos os CLIs.
- Execuções reais opcionais confirmam que Codex e Claude aceitam o schema escolhido.
- Saída que tenta alterar `raw/` ou `system/` é bloqueada.
- Falha do CLI preserva logs sanitizados e permite retry.
- Aprovar um arquivo e rejeitar outro aplica somente o aprovado.
- A wiki não muda antes de uma decisão explícita de revisão.

## Dependências

- PRD 001 para jobs e estado.
- PRD 003 para raws reais; fixtures podem antecipar desenvolvimento.

## Riscos

- Mudanças de flags ou formatos nos CLIs.
- Diferenças de comportamento entre agentes.
- Prompt injection dentro de fontes capturadas.
- Saídas longas ou truncadas.

## Mitigações

- Adapters versionados e testes de compatibilidade.
- Fontes são tratadas como dados não confiáveis nos prompts.
- Limites de saída, schemas e validação de caminhos.
- Nenhum bypass de revisão no MVP.

## Métricas de sucesso

- Taxa de propostas estruturalmente válidas por adapter.
- Percentual de propostas aprovadas, editadas e rejeitadas.
- Tempo até primeira proposta e até aprovação.
- Zero escrita fora do escopo nos testes adversariais.
