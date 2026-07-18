# PRD 002 — Plataforma de Plugins

## Problema

Formatos e plataformas de origem mudam em ritmos diferentes. Acoplar Docling, crawlers, yt-dlp ou Git ao núcleo tornaria o Sheldon difícil de instalar, testar e evoluir.

## Objetivo

Criar um sistema seguro e multilíngue para descobrir, selecionar, executar e diagnosticar plugins de ingestão como processos locais isolados.

## Escopo

- Manifesto de plugin versionado.
- Protocolo JSONL sobre stdin/stdout.
- Descoberta de plugins oficiais e instalados pelo usuário.
- Seleção por `probe` com prioridade e confiança.
- Execução com diretório temporário, timeout e cancelamento.
- Healthcheck e diagnóstico de dependências.
- SDK TypeScript e suíte reutilizável de testes de contrato.
- Instalação local explícita e remoção segura.

## Fora de escopo

- Marketplace remoto.
- Download automático de binários sem confirmação.
- Sandbox de segurança equivalente a contêiner ou máquina virtual.
- Lógica específica de PDF, web, vídeo ou Git.

## Contrato obrigatório

### Manifesto

O manifesto declara nome, identificador, versão, versão do protocolo, licença, comando, capacidades, plataformas, acesso à rede, uso de cookies e dependências externas.

### Operações

- `describe`: retorna metadados efetivos.
- `probe`: recebe uma entrada sanitizada e retorna suporte, confiança e motivo.
- `ingest`: recebe entrada, opções e diretório temporário; devolve `SourceArtifact[]`.
- `healthcheck`: retorna checks com severidade e correção sugerida.
- `cancel`: encerra trabalho cooperativamente quando possível.

Stdout é reservado a envelopes JSONL válidos. Stderr é reservado a logs. O plugin nunca recebe o caminho gravável do vault.

## Requisitos funcionais

1. O host rejeita plugins com protocolo incompatível antes da execução.
2. Resultados são validados contra schema e limites de tamanho.
3. O host encerra a árvore de processos em timeout ou cancelamento.
4. O diretório temporário é único por execução.
5. Plugins empatados em confiança exigem regra explícita ou escolha do usuário.
6. `sheldon plugin list` mostra origem, versão, saúde, licença e capacidades.
7. `sheldon plugin doctor <id>` executa somente diagnósticos declarados.
8. Instalação nunca executa scripts remotos ocultos.
9. Um plugin pode ser um pacote Node, ambiente Python gerenciado ou executável.
10. O núcleo registra duração, saída, erro e versão sem capturar segredos conhecidos.

## Critérios de aceitação

- Um plugin de fixture em Node e um executável de fixture obedecem à mesma suíte de contrato.
- JSON inválido encerra a execução sem escrever no vault.
- Timeout mata o processo filho e seus descendentes.
- Cancelamento deixa um diagnóstico claro e nenhum artefato promovido.
- Plugin que escreve logs em stderr continua sendo considerado bem-sucedido quando retorna resultado válido.
- Plugin que declara licença ausente ou incompatível não pode ser oficial.

## Dependências

- PRD 001 para configuração, jobs e diretórios temporários.

## Riscos

- Encerramento de árvores de processos no Windows.
- Dependências Python volumosas ou conflitantes.
- Plugins maliciosos continuam sendo processos locais; o manifesto não é sandbox forte.

## Métricas de sucesso

- Cem por cento dos plugins oficiais passam pela suíte de contrato.
- Falhas de plugin nunca deixam raws parciais promovidos.
- Healthcheck identifica dependências ausentes antes da primeira ingestão.
