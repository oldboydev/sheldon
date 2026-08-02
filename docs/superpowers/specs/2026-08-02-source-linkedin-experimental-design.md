# Design — Source LinkedIn experimental

## Objetivo

Capturar um único post público ou LinkedIn Article público como conhecimento local rastreável, sem
autenticação, automação de navegador, coleta de perfil ou dependência operacional entre plugins.

## Fronteira de entrada

`source.linkedin` aceita apenas HTTPS, sem credenciais, para os formatos canônicos de post individual
e Article. O canonizador remove fragmento e parâmetros de rastreamento, normaliza o host e recusa
rotas de perfil, feed geral, busca, empresa, newsletter e login. Um URL LinkedIn conhecido, mas fora
da fronteira, faz `probe` retornar uma razão específica; hosts desconhecidos permanecem desconhecidos.

O plugin possui prioridade abaixo de uma seleção explícita do usuário, mas acima de `source.url` para
essas rotas. A seleção de `source.url` continua sendo a alternativa para páginas públicas comuns.

## Captura limitada

O cliente de rede recebe uma única URL canônica e usa um timeout por tentativa, orçamento de HTML e
allowlist de hosts. Ele segue somente poucos redirecionamentos que terminem em rota LinkedIn ainda
aceita. A resposta não executa JavaScript, não usa perfil de browser, cookie, token, OAuth ou header
de autorização.

Há no máximo uma tentativa inicial e duas novas tentativas para resposta transitória ou falha de
rede. Os atrasos exponenciais são limitados, observam cancelamento e não são usados para acesso
restrito, login, URL inválida ou página removida.

## Extração de texto

O parser opera sobre HTML recebido em fixtures locais. Ele escolhe regiões semânticas renderizadas e
metadados públicos estritamente permitidos; não interpreta blobs de estado de aplicação, scripts ou
JSON que possa conter estado de sessão. Há dois extratores:

- **post:** corpo textual do post, autor ou entidade visível, data e URL canônica quando presentes;
- **article:** título, autoria, data e corpo do Article.

Comentários, reações, contadores, chamadas de engajamento e texto de navegação são excluídos. Campos
ausentes viram lacuna de metadado, nunca conteúdo inventado. Se a estrutura não permitir separar com
segurança conteúdo de interface, a captura falha com `LINKEDIN_PLATFORM_CHANGED` em vez de publicar
texto duvidoso.

## Raws e sanitização

Cada execução bem-sucedida publica exatamente:

- `original.page.html` como único raw `original`;
- `content.md` como versão normalizada e citável;
- `assets/post.txt` ou `assets/article.md` com o texto de origem;
- `assets/metadata.json` com tipo, URL canônica, título, autor/entidade, data e avisos permitidos.

O normalizador remove URLs assinadas, parâmetros de rastreamento e qualquer campo de sessão antes de
metadados ou Markdown. Cabeçalhos de resposta nunca são preservados.

## Imagens e OCR

A primeira entrega textual não baixa mídia. A extensão `--media images` altera o manifesto para
declarar `media: true` e baixa, apenas quando requisitada, até cinco imagens públicas regulares dentro
do orçamento de 10 MiB por arquivo e 20 MiB agregado. Cada arquivo passa por allowlist de host,
redirecionamento, limite durante streaming, tipo por magic bytes e verificação de arquivo regular
antes de virar `assets/images/<digest>.<ext>`.

`--ocr` não será implementado como uma chamada de `source.linkedin` para `source.image`. O host terá
um protocolo de derivação de anexos: recebe assets já materializados, seleciona explicitamente um
derivador instalado, cria diretório temporário e processo isolados e publica `assets/ocr/<digest>.txt`
somente após validar o resultado. A derivação declara seu efeito OCR e saúde independentemente. Assim,
uma falha de OCR é aviso por imagem, e nunca falha do processo social nem acesso implícito ao runtime
privado de outro plugin.

Documentos, carrosséis, áudio e vídeo não pertencem a esse protocolo inicial. Links externos anexados
permanecem metadados: não são baixados nem seguidos.

## Diagnósticos

- `LINKEDIN_INPUT_INVALID`: URL não canônica ou tipo de entrada inválido.
- `LINKEDIN_ACCESS_RESTRICTED`: login, permissão ou conteúdo não público.
- `LINKEDIN_RATE_LIMITED`: limite explícito da plataforma depois do backoff finito.
- `LINKEDIN_CONTENT_UNAVAILABLE`: conteúdo removido ou não encontrado.
- `LINKEDIN_PLATFORM_CHANGED`: HTML público não permite extração segura.
- `LINKEDIN_MEDIA_LIMIT_EXCEEDED`: imagem solicitada excede orçamento.
- `LINKEDIN_OCR_UNAVAILABLE`: `--ocr` foi solicitado sem derivador saudável.
- `LINKEDIN_EXTRACTION_FAILED`: falha residual, sem classificar conteúdo ou segredo como causa.

Cada código traz mensagem e remediation estáveis. Nenhum caminho de cookie, token, URL assinada ou
corpo de resposta entra no diagnóstico.

## Testes e release

O desenvolvimento segue red-green-refactor com fixtures HTML e HTTP locais. Testes unitários cobrem
canonização, classificação de probe, sanitização, parse de post/Article e diagnósticos. Testes de
integração cobrem limites, retry cancelável, redirecionamento recusado, asset de imagem, OCR isolado e
ausência/desinstalação do plugin. Não há chamada viva ao LinkedIn em testes ou release.

O plugin não empacota `yt-dlp`, browser ou credenciais. O catálogo oficial declara seu status
experimental; healthcheck valida somente as dependências declaradas e uma falha dele não impede os
demais plugins nem o núcleo.
