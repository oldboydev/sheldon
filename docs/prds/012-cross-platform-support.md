# PRD 012 — Suporte efetivo a Linux e macOS

## Problema

O código e os artefatos oficiais já declaram Linux e macOS, mas o contrato do MVP ainda é
Windows-first: a CI integral só roda em Windows, os caminhos operacionais priorizam `APPDATA` e o
encerramento garantido de árvores de processos depende do Job Object nativo. Declarar plataformas
sem garantir os mesmos limites de segurança e validação cria uma promessa de suporte enganosa.

## Objetivo

Tornar Sheldon oficialmente suportado em Windows x64, Linux x64 e macOS Intel/Apple Silicon, com o
mesmo núcleo local-first, isolamento de plugins, instalação oficial e gate de qualidade por
plataforma.

## Escopo

- Windows x64, Ubuntu 22.04+ x64, macOS 14+ arm64 e macOS 14+ x64.
- Diretórios de configuração, estado, cache temporário e plugins conformes à plataforma, com
  migração segura do estado Windows existente.
- Encerramento de árvore de processo equivalente: Job Object no Windows e grupo de processo POSIX em
  Linux/macOS.
- CI e release verificando a suíte apropriada e os artefatos executáveis nas quatro variantes.
- Instalação oficial, permissões executáveis, locks, symlinks, paths e diagnósticos consistentes nas
  plataformas suportadas.
- Documentação de instalação, pré-requisitos e limites por sistema operacional.

## Fora de escopo

- Linux arm64, Windows arm64, BSD, WSL como plataforma distinta ou dispositivos móveis.
- Sincronização de vault, Git remoto/autenticado, STT central ou novos conectores.
- Sandbox de segurança do sistema operacional para plugins locais.
- Suporte a versões de Node, distribuições Linux ou versões de macOS fora da matriz publicada.

## Requisitos funcionais

1. O suporte publicado cobre Windows x64, Ubuntu 22.04+ x64, macOS Intel x64 e Apple Silicon arm64
   com a versão LTS de Node definida pela CI. Uma combinação sem artefato e gate não pode aparecer
   como suportada.
2. Configuração, registro de plugins e estado usam `%APPDATA%\\Sheldon` no Windows; em POSIX usam
   `XDG_CONFIG_HOME/sheldon` e `XDG_STATE_HOME/sheldon`, com os fallbacks XDG convencionais. Cache e
   temporários usam diretório específico da operação e nunca entram no vault. O estado Windows já
   existente permanece legível.
3. Um plugin recebe processo ou grupo exclusivo. Em Linux/macOS, timeout, cancelamento e erro de
   protocolo encerram primeiro o grupo com sinal terminável e, após prazo curto, com sinal não
   ignorável; descendentes que herdaram pipes não podem manter a operação viva. O host nunca envia
   sinal ao próprio grupo ou a um PID não validado.
4. O contrato de lease e artefatos preserva as validações atuais de containment, symlink, arquivo
   regular, tamanho, hash, case sensitivity e permissões em cada sistema. Diferenças legítimas de
   case sensitivity e bit executável são explicitamente testadas, não inferidas de Windows.
5. `plugin install`, `plugin doctor`, `ingest`, consulta, bundle e interface local funcionam na
   matriz suportada sem pré-requisito Windows. Diagnósticos mencionam o pré-requisito real da
   plataforma, sem sugerir caminho ou ferramenta inexistente.
6. Artefatos oficiais contêm somente executáveis do alvo, preservam o bit executável em POSIX e são
   verificados após extração. Runtimes macOS são assinados/notarizados antes da publicação, ou a
   publicação falha com diagnóstico explícito; nenhuma instrução pede ao usuário para desativar
   proteções globais do sistema.
7. Toda pull request roda o gate unificado em Windows, Ubuntu e macOS. A variante Intel macOS e a
   Apple Silicon têm smoke de artefato em cada release e validação periódica; uma falha bloqueia a
   promoção da plataforma afetada.
8. A documentação declara matriz, local dos dados, instalação, remoção, recuperação e limitações
   conhecidas. O roadmap só remove Linux/macOS do pós-MVP depois que a matriz estiver verde.

## Critérios de aceitação

- Uma fixture que cria pai e descendente confirma que timeout e cancelamento eliminam ambos em
  Windows, Linux e macOS, inclusive quando o pai encerra e o descendente conserva stdout/stderr.
- Testes de paths cobrem `APPDATA`, XDG explícito, fallback XDG, migração Windows, case sensitivity,
  symlink e caminho contendo espaços.
- O gate de CI executa os testes e a cobertura nas plataformas suportadas; skips são limitados a uma
  diferença documentada e têm teste equivalente no sistema aplicável.
- O release instala cada ZIP em diretório limpo, confirma permissões, executa `describe`/`healthcheck`
  e exercita OCR/yt-dlp somente no runtime do alvo.
- Um usuário consegue criar vault, ingerir fonte, consultar, gerar bundle e iniciar a web local em
  cada sistema sem editar caminhos internos.
- Nenhum teste, log, metadata, vault ou artefato expõe segredo, cookie ou estado de outra plataforma.

## Dependências

- PRD 002 para ciclo de vida, isolamento e instalação de plugins.
- PRD 003 para publicação de raws e runtimes de ingestão.
- PRD 008 e PRD 009 para bundle e interface local na matriz de sistemas.

## Riscos e mitigações

- **Sinais POSIX e órfãos:** criar grupo isolado e testar descendentes reais; nunca matar PID/grupo
  sem titularidade conhecida.
- **ABI Linux e Gatekeeper macOS:** publicar somente baselines testadas, validar runtime extraído e
  exigir assinatura/notarização macOS antes do release.
- **Custo de CI macOS:** manter gate essencial por PR e smoke Intel/arm64 em release e agenda; não
  promover artefato quando a variante correspondente não estiver verde.
- **Migração de paths:** não mover vault automaticamente; manter leitura do estado Windows e oferecer
  migração explícita, idempotente e reversível por cópia.

## Métricas de sucesso

- Sucesso do gate por plataforma e arquitetura.
- Número de órfãos após timeout/cancelamento igual a zero nos testes de ciclo de vida.
- Instalação e healthcheck bem-sucedidos por artefato publicado.
- Zero regressão na leitura de estado Windows e zero path dependente de sistema em diagnósticos.
