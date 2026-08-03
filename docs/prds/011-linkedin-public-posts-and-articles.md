# PRD 011 — Posts e artigos públicos do LinkedIn

## Problema

Posts e artigos profissionais do LinkedIn podem conter conhecimento relevante, mas a plataforma
aplica autenticação, limites e mudanças frequentes. Um conector não pode transformar uma URL pública
em coleta de perfil, feed ou conteúdo protegido.

## Objetivo

Adicionar o plugin experimental `source.linkedin` para capturar, de modo local e limitado, um post
individual público ou um LinkedIn Article público, preservando texto e imagens autorizadas sem
cookies, OAuth, automação de navegador ou bypass.

## Escopo

- URLs HTTPS canônicas de posts individuais e LinkedIn Articles públicos.
- Texto visível, autor ou entidade visível, data quando disponível e URL canônica.
- HTML original, conteúdo normalizado, texto e metadados em raws separados.
- Imagens públicas como assets somente por opção explícita do usuário.
- Fronteira reutilizável, orquestrada pelo host, para OCR local opt-in de imagens.
- Limites de bytes, tempo, quantidade de imagens, redirecionamentos e tentativas.
- Diagnósticos estáveis para acesso restrito, rate limit, conteúdo indisponível e mudança de
  plataforma.

## Fora de escopo

- Perfis, feeds, resultados de busca, páginas de empresa, newsletters, eventos e coleta em lote.
- Comentários, reações, republicações, métricas, conexões, mensagens ou qualquer interação.
- Cookies, OAuth, tokens, APIs parceiras, browser automatizado, JavaScript executado ou CAPTCHA.
- Bypass de login, conteúdo privado, paywall, DRM, anti-bot ou URLs de mídia protegidas.
- Seguir links externos anexados ao post.
- Download de documentos, carrosséis, vídeo ou áudio nesta fatia.

## Requisitos funcionais

1. `probe` aceita somente uma URL de post ou artigo e diferencia URL LinkedIn conhecida, mas fora de
   escopo, de uma entrada desconhecida.
2. O plugin busca somente a página pública solicitada. Redirecionamentos precisam terminar em host
   LinkedIn permitido e não podem mudar a entrada para perfil, feed ou login.
3. O manifesto declara `network: true`, `cookies: false`, mídia e OCR; o OCR é executado somente
   pela fronteira de derivação do host, nunca pelo processo social.
4. A captura de texto não executa JavaScript nem lê estado de navegador. Texto ausente nunca é
   inventado e conteúdo de comentários não é incorporado.
5. O raw contém exatamente um original `original.page.html`, um `content.md`, texto específico do
   tipo em `assets/post.txt` ou `assets/article.md` e `assets/metadata.json` sanitizado.
6. Após a extensão de mídia, `--media images` é explícito, preserva no máximo cinco imagens públicas
   regulares, até 10 MiB cada e 20 MiB no total. O padrão continua sem download de mídia.
7. Após a extensão de OCR, `--ocr` só pode ser usado junto de `--media images`. O host orquestra a
   derivação como trabalho isolado; `source.linkedin` nunca executa nem chama `source.image`.
8. Falha para derivar uma imagem não remove texto já válido; o raw registra aviso estável por asset e
   nunca inventa OCR. Indisponibilidade global solicitada por `--ocr` falha antes da rede com
   diagnóstico acionável.
9. A página inicial mais no máximo duas tentativas transitórias respeitam cancelamento e usam
   backoff limitado. Nenhum retry ocorre para login, conteúdo removido ou URL fora de escopo.
10. Cookies, cabeçalhos de autorização, URLs assinadas, parâmetros de rastreamento e conteúdo de
    sessão não podem constar em stdout, stderr, protocolo, metadados ou raws.

## Critérios de aceitação

- Um fixture de post público produz HTML original, texto do post, metadados e `content.md` sem
  comentários ou reações.
- Um fixture de Article público produz título, autoria quando presente e corpo normalizado sem
  executar JavaScript.
- Uma imagem pública só é baixada com a opção explícita e respeita todos os orçamentos.
- OCR opt-in produz artefato separado por imagem, ou aviso/diagnóstico estável sem apagar o raw
  principal quando uma derivação falha.
- Login, acesso privado, rate limit, página removida e alteração estrutural recebem diagnósticos
  diferentes e acionáveis.
- Fixtures, logs e raws de teste não contêm cookie, token, cabeçalho de autorização ou URL assinada.
- A suíte do núcleo continua aprovada com `source.linkedin` ausente, indisponível ou desinstalado.

## Dependências

- PRD 002 para contrato, isolamento e instalação de plugins.
- PRD 003 para publicação de raws, limites de ingestão e OCR de imagem.
- PRD 010 para a política de conectores sociais experimentais e diagnósticos de plataforma.

## Riscos

- A apresentação pública pode mudar ou exigir login.
- Uma imagem pode ser servida por URL temporária ou host não confiável.
- OCR de um anexo pode criar acoplamento indevido entre plugins.
- Uma expansão de anexos pode virar crawler de links externos.

## Mitigações

- Parser por fixture, diagnóstico de mudança de plataforma e nenhuma técnica de contorno.
- Allowlist, validação de tipo e orçamento para cada imagem antes de persistir.
- Protocolo de derivação pertencente ao host, com processos separados e falha por asset.
- Um único documento de origem; links anexados permanecem apenas metadados sanitizados.

## Métricas de sucesso

- Taxa de captura por post e Article, separada por versão do plugin.
- Distribuição de `LINKEDIN_*` por categoria, sem erros genéricos predominantes.
- Zero segredo ou URL assinada em fixtures e raws.
- Nenhuma regressão de ingestão quando o plugin ou a derivação OCR falha.
