# Design — Source Instagram experimental

## Objetivo

Capturar um Reel ou post de vídeo público em raws locais separados, sem tornar o núcleo dependente
da plataforma ou persistir credenciais de sessão.

## Limites de segurança

- Aceita apenas URLs HTTPS canônicas de `instagram.com/reel/<id>` e `instagram.com/p/<id>`.
- Nunca tenta acesso privado, DRM, paywall, captcha ou bypass anti-bot.
- Um arquivo de cookie opcional é validado como arquivo local regular e passado apenas ao processo
  isolado pela variável `SHELDON_SOCIAL_COOKIE_FILE`; caminho e conteúdo não entram no protocolo,
  vault, manifesto, stdout ou stderr persistido.
- `yt-dlp` e todas as saídas dele são não confiáveis. Caminhos de legenda e mídia devem permanecer
  dentro do diretório temporário, sem links simbólicos, antes de qualquer leitura ou publicação.

## Runtime e isolamento

O release oficial contém o mesmo runtime verificado de `yt-dlp` por plataforma usado pelo
conector YouTube. O plugin resolve somente esse runtime, executa sem shell e faz healthcheck de
versão limitado. A ausência do runtime desabilita apenas este plugin com diagnóstico acionável.

STT é estritamente local e opcional. Para usá-lo, o ambiente deve declarar
`SHELDON_LOCAL_STT_EXECUTABLE` e pode declarar `SHELDON_LOCAL_STT_ARGUMENTS` como array JSON de
argumentos com no máximo um placeholder `{input}`. O adaptador executa sem shell, baixa apenas um
áudio temporário de até 50 MiB quando não há legenda e nunca baixa modelos.

## Captura e raws

O plugin escreve um original metadata JSON sanitizado, `content.md`, e assets separados para texto
do post, transcrição, metadados e thumbnail explicitamente autorizado. Metadados sensíveis, como
headers e URLs assinadas, não são preservados. Sem fala, publica conteúdo válido com estado `gap`,
sem inventar uma transcrição.

## Limites e diagnósticos

Tentativas transitórias usam backoff exponencial finito e respeitam cancelamento. Downloads de
mídia são opt-in, têm orçamento explícito e retornam `INSTAGRAM_MEDIA_LIMIT_EXCEEDED` antes de
publicar excedentes. Diagnósticos distinguem entrada inválida, autenticação, bloqueio, rate limit,
runtime, STT e resposta inválida.
