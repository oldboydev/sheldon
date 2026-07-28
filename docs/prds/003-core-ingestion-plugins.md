# PRD 003 — Plugins Oficiais de Ingestão

## Problema

O usuário precisa capturar arquivos, sites, YouTube e repositórios de forma uniforme, sem pagar APIs e sem usar LLM para tarefas determinísticas.

## Objetivo

Entregar quatro famílias de plugins oficiais que geram raws imutáveis, reproduzíveis e normalizados em Markdown.

## Situação de implementação (julho de 2026)

Este PRD preserva o escopo original abaixo. A fatia implementada cobre `source.file`,
uma URL pública única e o crawl público limitado de `source.url`, um vídeo público
único do YouTube com legendas e snapshots locais estritos de `HEAD` por
`source.repository`.

`source.image`, seu runtime nativo de OCR e STT local estão pausados. URLs Git
remotas e autenticação Git ficam adiadas. Playlists e canais do YouTube estão
adiados para depois do MVP conforme o escopo atual do usuário. Esses itens não
devem ser lidos como compromisso da fatia atual.

## Escopo

### Arquivos

- PDF, Markdown, texto, HTML, DOCX, PPTX, XLSX, EPUB e imagens comuns.
- Seleção entre conversores locais compatíveis, priorizando preservação estrutural.
- OCR local quando o formato exigir e a dependência estiver instalada.

**Situação atual:** `source.file` cobre documentos e dados locais; imagens e OCR
pertencem a `source.image`, que está pausado.

### Sites

- Uma página ou crawl limitado de um site.
- Respeito a escopo de domínio, profundidade, limite de páginas e exclusões.
- Conteúdo principal em Markdown, metadados, links e assets opcionais.

**Situação atual:** concluída para página pública única e crawl público limitado
por `ingest crawl`, com limites explícitos de páginas e profundidade.

### YouTube

- Vídeo individual, playlist ou canal com limites explícitos.
- Metadados e legendas disponíveis via yt-dlp.
- Transcrição local configurável quando não houver legenda utilizável.

**Situação atual:** somente vídeo público individual com legendas. Playlists,
canais e STT local estão adiados; playlist/canal ficam para depois do MVP no
escopo atual do usuário.

### Repositórios

- Diretório local ou URL Git pública/privada autenticada pelo ambiente do usuário.
- Snapshot de commit, árvore, documentação e código selecionado.
- Respeito a ignore files, limites de tamanho e detecção de segredos.

**Situação atual:** somente diretório Git local, legível e byte a byte idêntico a
`HEAD`. Clones, remotos e autenticação Git estão adiados.

## Fora de escopo

- Firecrawl ou transcrição como serviço.
- Bypass de paywalls, DRM ou controles de acesso.
- Perfis completos de redes sociais.
- Análise semântica e escrita da wiki.

## Artefato normalizado

Cada captura gera:

```text
raw/<source-id>/
  manifest.yaml
  original.*
  content.md
  assets/
```

O manifesto inclui URI canônica, hash, tipo, timestamps, plugin, versão, opções, status de extração, idioma conhecido, relações de versão e avisos. O conteúdo Markdown identifica lacunas de extração sem inventar texto.

## Requisitos funcionais

1. O plugin apropriado é selecionado automaticamente e pode ser sobrescrito pelo usuário.
2. SHA-256 evita duplicação do mesmo conteúdo com as mesmas opções relevantes.
3. Nova versão da fonte cria novo raw ligado à versão anterior.
4. Originais são preservados quando permitido e viável.
5. Crawls têm limites obrigatórios e produzem inventário de URLs visitadas, puladas e falhas.
6. YouTube prefere legenda manual, depois alternativas configuradas; STT local nunca é baixado silenciosamente.
7. Repositórios registram commit e recusam incluir segredos detectados até revisão explícita.
8. Uma falha parcial pode ser retomada quando o plugin suporta checkpoints.
9. Ferramentas e modelos locais opcionais aparecem no healthcheck com tamanho e licença.
10. Nenhum caminho do MVP exige chave de API paga.

## Critérios de aceitação históricos

Os critérios a seguir registram a intenção original do PRD. Os que dependem de
OCR de imagens, STT local, playlists/canais ou Git remoto/autenticado estão
adiados para trabalho posterior ao MVP e não são critérios de saída da fatia
atual.

- Fixtures de cada formato produzem Markdown estável em execuções repetidas.
- Reingestão idêntica retorna o raw existente em vez de duplicá-lo.
- Crawl nunca ultrapassa domínio, profundidade ou limite configurado.
- Vídeo com legenda é ingerido sem executar STT.
- Vídeo sem legenda informa a opção local disponível e falha de forma acionável quando ela não está instalada.
- Repositório com segredo de fixture é bloqueado antes de produzir contexto consumível.
- Ferramenta ausente é diagnosticada antes da execução longa.

## Dependências

- PRD 001 para vault e jobs.
- PRD 002 para execução de plugins.

## Riscos

- Mudanças em sites e YouTube.
- Conversão imperfeita de layouts complexos.
- Downloads e modelos locais grandes.
- Licenças diferentes entre ferramenta e modelos associados.

## Métricas de sucesso

- Taxa de sucesso por família e tipo de fonte.
- Percentual de reingestões deduplicadas.
- Tempo, tamanho e avisos por captura.
- Zero chamadas a APIs pagas nos testes oficiais.
