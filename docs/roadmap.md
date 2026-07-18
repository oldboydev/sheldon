# Sheldon — Roadmap

## Estratégia

O roadmap entrega fatias verificáveis. Cada marco termina com software demonstrável e critérios de saída próprios. Datas serão definidas somente quando houver capacidade de execução; a ordem representa dependências técnicas e de produto.

## Marcos

### M0 — Fundação local

**PRD:** 001

Entrega: CLI inicial, vault central, tópicos, projetos, configuração e SQLite operacional.

Saída: criar um vault, reiniciar o processo e reencontrar o mesmo estado sem depender da web.

### M1 — Plataforma de plugins

**PRD:** 002

Entrega: descoberta, protocolo JSONL, execução isolada, healthcheck, timeout, cancelamento e testes de contrato.

Saída: executar um plugin de fixture em Node e outro processo externo com comportamento equivalente.

### M2 — Primeira memória funcional

**PRDs:** 003, 004 e 005

Entrega: arquivo local vira raw; Codex ou Claude gera proposta; usuário aprova; conceito entra na wiki.

Saída: fluxo completo repetível pelos dois agentes, com fontes e diff de revisão.

Este marco é um checkpoint vertical: utiliza primeiro o caminho de arquivo local do PRD 003. O PRD 003 só é considerado concluído no M3, após as quatro famílias de ingestão passarem por seus critérios de aceitação.

### M3 — Ingestão completa do MVP

**PRD:** 003

Entrega: plugins oficiais para arquivos, sites inteiros, YouTube e repositórios.

Saída: cada família possui fixtures, deduplicação e diagnóstico offline; nenhuma exige API paga.

### M4 — Conhecimento cumulativo

**PRD:** 006

Entrega: busca local, consulta citada, arquivamento de respostas e promoção para nova proposta.

Saída: uma pergunta cruzando conceitos gera resposta rastreável e pode enriquecer a wiki.

### M5 — Conhecimento dentro de projetos

**PRD:** 007

Entrega: MCP local, skill Sheldon e configuração de um projeto consumidor.

Saída: Codex e Claude, dentro de outro repositório, localizam e citam conhecimento relevante sem receber o vault inteiro.

### M6 — Portabilidade OKF

**PRD:** 008

Entrega: definição de seleção, compilador, índice, log, manifesto e validador OKF v0.1.

Saída: bundle reconstruível, conformante e utilizável sem Sheldon.

### M7 — MVP utilizável

**PRD:** 009

Entrega: interface web local para fontes, trabalhos, revisão, wiki, consulta, plugins e bundles.

Saída: o fluxo principal pode ser concluído sem conhecer comandos da CLI.

### M8 — Conectores sociais experimentais

**PRD:** 010

Entrega: framework de plugins autenticados por cookies locais e primeiros conectores sociais.

Saída: falhas de plataforma são diagnosticadas claramente e nunca comprometem o núcleo.

## Definição do MVP

No Windows, o usuário consegue:

1. criar tópicos e projetos;
2. ingerir arquivo, site, YouTube ou repositório;
3. preservar raws sem LLM;
4. compilar via Codex ou Claude Code;
5. revisar e aprovar alterações;
6. pesquisar e consultar com citações;
7. usar conhecimento em outro projeto via MCP e skill;
8. gerar e validar um bundle OKF;
9. concluir tudo sem API paga obrigatória.

## Depois do MVP

- Linux e macOS.
- Plugins de redes sociais adicionais.
- Busca vetorial local opcional.
- Visualização do grafo.
- Agendamentos e manutenção autônoma revisável.
- Importação de bundles OKF externos.
- Sincronização opcional escolhida pelo usuário.
