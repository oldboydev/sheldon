# `@sheldon/ingestion`

Publicador confiável dos raws produzidos pela ingestão. O pacote recebe artefatos temporários de uma lease já validada pelo `@sheldon/plugin-host`, calcula a identidade da fonte e publica a captura imutável em `raw/<source-id>/` por staging e rename atômico.

## Fronteira de confiança

O processo do plugin não escreve no vault e seus caminhos, hashes e tamanhos não são aceitos diretamente. Antes de conceder a lease, o host confirma que cada artefato permanece no diretório temporário canônico, aponta para um arquivo regular, possui o tamanho e o SHA-256 declarados e respeita os limites por arquivo e agregados.

Este pacote é o lado confiável da publicação. Ele exige um artefato `original` e um `normalized`, restringe assets a caminhos relativos sob `assets/`, copia apenas arquivos da lease validada e grava o manifesto por último. Uma falha remove o staging e não deixa um raw parcial. O término da lease também remove os temporários do plugin.

Essa fronteira valida integridade e confinamento de caminhos; ela não transforma o plugin em sandbox. Plugins continuam executando com os acessos do usuário atual, conforme documentado pelo host.

Para imagens, o artefato normalizado é gerado exclusivamente por `source.image`: o OCR usa o runtime e os modelos de idioma instalados dentro da própria raiz do plugin. `source.file` não reivindica imagens, e a publicação continua recebendo os mesmos artefatos `original` e `normalized` validados pela lease.

## Layout publicado

```text
raw/<source-id>/
  manifest.yaml
  original.<extensão>
  content.md
  assets/
```

O `source_id` é o SHA-256 dos bytes originais e das opções relevantes serializadas de forma estável. Uma publicação idêntica reutiliza o raw existente. Para a mesma `canonical_uri` e o mesmo `options_sha256`, conteúdo novo cria uma captura e aponta `previous_source_id` para a versão anterior.

## Campos do manifesto

- `source_id`: identidade determinística da captura.
- `canonical_uri` e `original_name`: proveniência da entrada local.
- `content_sha256` e `options_sha256`: hashes dos bytes originais e das opções normalizadas.
- `captured_at`: instante ISO 8601 da publicação.
- `plugin`, `plugin_version` e `extractor`: implementação que gerou os artefatos.
- `options`: opções relevantes para a extração e a deduplicação.
- `original` e `content`: caminho relativo, tamanho, media type e SHA-256; `content.path` é sempre `content.md`.
- `assets`: descritores dos arquivos publicados sob `assets/`.
- `extraction`: `status` (`complete` ou `gap`), formato detectado, avisos e idioma quando conhecido.
- `previous_source_id`: identidade opcional da versão anterior para a mesma URI e opções.

Manifestos legados do fluxo M2 continuam reconhecíveis para deduplicação quando possuem identidade compatível; novas publicações usam o formato completo acima.
