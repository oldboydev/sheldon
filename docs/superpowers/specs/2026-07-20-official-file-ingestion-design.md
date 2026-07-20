# Ingestão oficial de arquivos — design

**Data:** 2026-07-20

## Objetivo

Concluir a família de arquivos do PRD 003, substituindo o caminho interno e
limitado do M2 por um plugin oficial executado pela plataforma de plugins do
M1. O comando existente continua recebendo a entidade de destino e um caminho
de arquivo; ele não recebe nem exige que a pessoa usuária escolha o formato do
arquivo.

O resultado é uma captura reproduzível em `raw/<source-id>/`, sem APIs pagas,
com seleção automática de plugin, extração local, diagnóstico e deduplicação.

## Escopo

Inclui arquivos locais regulares nos formatos PDF, Markdown, texto, HTML,
DOCX, PPTX, XLSX, EPUB, JSON, YAML e imagens comuns. Inclui OCR local
opcional, preservação do original, Markdown normalizado, assets quando houver,
deduplicação, relação entre versões, healthcheck e fixtures offline.

Não inclui sites, YouTube ou repositórios; eles são famílias separadas do M3.
Também não inclui download automático de engines, modelos OCR, serviços de
transcrição ou qualquer API paga.

## Decisão arquitetural

O projeto distribuirá um único plugin oficial, identificado como
`sheldon.file`. O identificador representa a família de entradas — qualquer
arquivo local — e não uma extensão. Por exemplo, `config.json` é uma entrada
tratada pelo mesmo plugin, não um plugin separado.

`sheldon.file` será descoberto com origem `official` pela infraestrutura do M1.
Seu `probe` recebe a entrada local e reconhece formatos pelo conteúdo e pela
extensão, retornando alta confiança para arquivos suportados. A seleção padrão
é automática; a CLI disponibiliza override explícito para outro plugin
compatível.

O plugin só extrai e descreve artefatos temporários. Ele nunca escreve no
vault. O Sheldon, fora do processo do plugin, valida a lease de artefatos do
host e publica o raw de maneira atômica. Esta separação mantém a escrita do
vault no código confiável, aplica os limites e a limpeza de temporários do host
e permite que plugins continuem isolados.

```text
sheldon memory ingest-file
  -> descoberta e probe do host
  -> sheldon.file
  -> extrator embarcado
  -> artefatos temporários validados pelo host
  -> orquestrador de ingestão
  -> raw/<source-id>/ no vault
```

O atual `LocalFileIngestor` do M2 será substituído por esse orquestrador. A
forma pública do comando é preservada: o primeiro argumento continua sendo o
tipo da entidade de destino, e não o tipo do arquivo.

## Componentes

### Plugin `sheldon.file`

O plugin implementa `describe`, `probe`, `ingest`, `healthcheck` e `cancel`
pelo SDK. Seu registro interno de extratores escolhe a biblioteca embarcada
adequada ao formato e produz artefatos `original`, `normalized` e, quando
aplicável, `asset`. Todos os extratores são determinísticos para a mesma entrada
e opções.

As bibliotecas para formatos estruturados são dependências do workspace, e não
programas que a pessoa usuária instala. O healthcheck verifica a disponibilidade
do runtime e informa as capacidades embarcadas. OCR permanece opcional: se uma
engine local e o modelo solicitado estiverem disponíveis, imagens podem gerar
texto; caso contrário o plugin preserva a imagem e emite um aviso acionável. A
ausência de OCR nunca aciona download automático.

### Orquestrador de ingestão

O orquestrador recebe a lease de artefatos aprovada pelo host e monta o raw
final. Ele preserva o original com sua extensão, escreve `content.md`, copia os
assets e gera `manifest.yaml`. A publicação ocorre em diretório de staging e
rename atômico; erros não deixam raw parcial.

O `source_id` é o SHA-256 dos bytes de origem e das opções semanticamente
relevantes serializadas de forma estável. Repetir a mesma captura devolve o raw
existente. Para a mesma URI canônica e mesmas opções, conteúdo diferente cria
novo raw e registra `previous_source_id` no manifesto, apontando à captura
anterior. O orquestrador obtém essa relação a partir dos manifestos existentes
sob `raw/`; assim não introduz um índice mutável adicional no MVP.

O manifesto registra URI canônica, hashes, timestamps, plugin e versão,
extrator, opções, status e avisos de extração, idioma conhecido, caminhos e
hashes de artefatos, além da relação de versão quando existir. Raws M2 já
existentes continuam legíveis; quando compatíveis com a identidade calculada,
uma reingestão os reconhece como deduplicados.

### CLI

`sheldon memory ingest-file <entity-kind> <slug> <file>` mantém o contrato de
uso. Antes de chamar o host, a CLI verifica que a entrada resolve para um arquivo
regular. O formato é inferido pelo probe. Uma opção de override permite pedir
um identificador de plugin; o host ainda valida compatibilidade.

Erros distinguem entrada não regular, nenhum plugin compatível, plugin forçado
incompatível, extração indisponível, OCR opcional ausente e falha de publicação.
As mensagens apontam a ação de recuperação sem expor caminhos temporários ou
conteúdo de arquivos.

## Regras de extração

- Markdown preserva a estrutura original; texto recebe um título derivado do
  nome do arquivo.
- HTML, PDF, Office, EPUB, JSON e YAML geram Markdown estrutural estável, sem
  inventar texto não extraído.
- Tabelas e metadados disponíveis são preservados quando o formato os expõe.
- Imagens preservam o arquivo original. Com OCR disponível, o texto extraído
  entra no Markdown e o manifesto informa engine, idioma e aviso aplicável.
- Formatos fora da matriz são capturados com `content.md` de lacuna explícita e
  status de extração correspondente.
- Opções que mudam o resultado, incluindo política e idioma de OCR, fazem parte
  da identidade de deduplicação.

## Segurança e confiabilidade

O host mantém a validação de tamanho, hash, caminho canônico e limites dos
artefatos temporários antes de conceder a lease. A CLI e o orquestrador aceitam
somente arquivos regulares. Nenhum extrator acessa rede; o manifesto do plugin
declara `network: false` e `cookies: false`. Cancelamento usa o protocolo do SDK
e limpa temporários pelo ciclo de vida já fornecido pelo host.

## Testes e critérios de aceite

Fixtures locais pequenas representarão cada formato suportado e serão usadas
por testes unitários do extrator, contrato do plugin, integração do host e
aceitação da CLI. A suíte prova que:

- cada fixture produz Markdown estável em execuções repetidas;
- seleção automática encontra `sheldon.file` e override válido é respeitado;
- o mesmo conteúdo e opções retorna o raw existente, enquanto opções ou bytes
  diferentes criam raw novo;
- uma nova versão para a mesma URI registra a captura anterior;
- o original, conteúdo e assets esperados são publicados, e falhas não deixam
  diretórios parciais;
- OCR indisponível dá diagnóstico sem download, e OCR disponível é usado de
  forma controlada;
- arquivos não regulares, artefatos inválidos e extratores que falham são
  rejeitados de modo acionável;
- nenhuma fixture, teste ou healthcheck exige chave ou chamada a API paga.

## Alternativas descartadas

Manter o ingestor interno do M2 reduziria alterações iniciais, mas evitaria a
descoberta, seleção, healthcheck e isolamento que o M3 exige. Criar um plugin
por extensão isolaria dependências, mas fragmentaria a experiência e a
priorização de probe sem benefício proporcional. Por isso o plugin único com
registro interno de extratores é a opção adotada.
