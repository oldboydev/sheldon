# Sheldon — Visão do Produto

## Resumo

Sheldon é um segundo cérebro pessoal, local-first, inspirado no padrão LLM Wiki. Ele transforma fontes dispersas em uma wiki Markdown cumulativa, revisável e utilizável por agentes de desenvolvimento.

O produto não é um chat com documentos. Fontes são capturadas uma vez, normalizadas por ferramentas determinísticas e compiladas em conhecimento durável por Codex CLI ou Claude Code. Consultas úteis retornam ao corpus, fazendo a base melhorar com o uso.

## Público inicial

Uma pessoa técnica trabalhando no Windows, com Codex CLI e Claude Code já instalados e autenticados. A arquitetura deve permitir suporte posterior a Linux e macOS sem alterar o modelo de conhecimento.

## Promessa central

> Capture uma fonte uma vez, transforme-a em conhecimento confiável e reutilize esse conhecimento em qualquer projeto ou agente.

## Princípios

1. **Arquivos são a fonte de verdade.** Raw, wiki e bundles são legíveis sem Sheldon.
2. **Ingestão não exige LLM.** Captura, extração e normalização usam ferramentas locais por padrão.
3. **LLM é compilador, não banco de dados.** Codex e Claude sintetizam, reconciliam e propõem mudanças.
4. **Revisão antes de autoridade.** Mudanças semânticas entram na wiki somente após aprovação.
5. **Conhecimento deve acumular.** Consultas relevantes podem gerar novas propostas para a wiki.
6. **Sem API paga obrigatória.** O Sheldon não chama APIs de modelos nem depende de SaaS pago.
7. **Extensibilidade por plugins.** Ingestores são processos isolados, substituíveis e diagnosticáveis.
8. **Portabilidade por compilação.** OKF é um artefato derivado para troca com projetos e agentes.
9. **Proveniência é obrigatória.** Afirmações duráveis devem apontar para suas fontes.
10. **Degradação explícita.** Falhas, lacunas e baixa confiança são mostradas, não escondidas.

## Resultados esperados

- Menos repetição de contexto ao iniciar tarefas com agentes.
- Uma wiki que se torna mais coerente e útil à medida que novas fontes entram.
- Respostas rastreáveis até raws imutáveis.
- Pacotes de conhecimento pequenos e relevantes para cada projeto.
- Liberdade para trocar Codex, Claude, plugins ou visualizadores sem migrar o conhecimento.

## Fora da visão inicial

- Serviço SaaS multiusuário.
- Colaboração, permissões organizacionais ou cobrança.
- Treinamento ou fine-tuning de modelos.
- Sincronização cloud obrigatória.
- Banco vetorial remoto.
- Garantia universal de ingestão de redes sociais protegidas por autenticação ou anti-bot.
