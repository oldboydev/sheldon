# PRD 010 — Plugins de Redes Sociais

## Problema

Posts, vídeos curtos e threads contêm conhecimento valioso, mas plataformas sociais mudam frequentemente, aplicam rate limits e exigem sessões autenticadas.

## Objetivo

Adicionar conectores sociais experimentais sem comprometer a estabilidade, privacidade ou gratuidade do núcleo.

## Escopo

- Extensão do contrato para plugins que usam cookies locais.
- Primeiro conector para Instagram Reels e posts de vídeo quando suportado por ferramentas locais.
- Captura de legenda, descrição, metadados, mídia permitida e transcrição local.
- Framework para conectores futuros de posts e vídeos.
- Diagnóstico explícito de bloqueio, autenticação e mudança de plataforma.

## Fora de escopo

- Compra de APIs oficiais.
- Bypass de acesso privado, paywall, DRM, captcha ou proteção anti-bot.
- Garantia de ingestão de perfil inteiro.
- Armazenamento centralizado de credenciais sociais.
- Automação de interação, postagem ou engajamento.

## Requisitos funcionais

1. Cookies são opcionais, ficam sob controle do usuário e nunca entram no vault ou logs.
2. O manifesto declara claramente acesso a cookies, rede e mídia.
3. `probe` diferencia URL suportada, plataforma conhecida porém bloqueada e entrada desconhecida.
4. O raw separa texto do post, transcrição, metadados e assets.
5. STT é local e segue as mesmas políticas do plugin YouTube.
6. Rate limits usam backoff limitado e nunca criam loop infinito.
7. Falha por autenticação ou bloqueio usa códigos diagnósticos estáveis.
8. Mudança de plataforma pode desabilitar apenas o plugin afetado.
9. Toda captura respeita limites definidos pelo usuário e termos aplicáveis.
10. O núcleo continua totalmente funcional sem plugins sociais instalados.

## Critérios de aceitação

- Reel público suportado gera raw com legenda e transcrição quando disponíveis.
- Mídia sem fala gera documento válido sem transcrição inventada.
- Cookie ou token nunca aparece em stdout, stderr, manifesto ou snapshot de teste.
- Bloqueio da plataforma produz diagnóstico acionável, não erro genérico.
- Desinstalar o plugin não afeta raws já capturados.
- Testes do núcleo passam mesmo quando todas as fixtures sociais estão desabilitadas.

## Dependências

- PRD 002 para plugins.
- PRD 003 para políticas de vídeo, STT e raws.

## Riscos

- Quebra frequente de extratores.
- Restrições legais e de termos de uso.
- Vazamento de sessão autenticada.
- Downloads grandes e conteúdo removido.

## Mitigações

- Status experimental e versão independente.
- Sem técnicas de bypass.
- Sanitização e testes específicos de segredo.
- Preservação local somente quando autorizada pelo usuário.

## Métricas de sucesso

- Sucesso por tipo de URL e versão do plugin.
- Diagnósticos classificados versus erros desconhecidos.
- Zero vazamento de credenciais em testes.
- Nenhuma regressão no núcleo causada por mudança de plataforma.
