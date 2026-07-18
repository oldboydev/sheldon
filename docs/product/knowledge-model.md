# Sheldon — Modelo de Conhecimento

## Camadas

Sheldon separa aquisição, síntese e distribuição.

### Raw

Um raw representa uma fonte capturada de modo reproduzível:

```text
raw/<source-id>/
  manifest.yaml
  original.*
  content.md
  assets/
```

`manifest.yaml` registra identificador estável, entrada original, URI canônica, hash, datas, plugin, versão, licença conhecida, status e relações com versões anteriores. `original.*` é preservado quando legal e tecnicamente possível. `content.md` é uma projeção normalizada e não deve ser editado manualmente.

### Proposta

Uma proposta é a saída estruturada de Codex ou Claude antes da aprovação. Ela contém:

- arquivos a criar, alterar ou arquivar;
- patches ou conteúdo completo;
- raws consultados;
- afirmações adicionadas ou removidas;
- contradições e incertezas;
- links e aliases sugeridos;
- versão do prompt e agente executor.

Propostas rejeitadas permanecem no histórico operacional, mas não viram conhecimento oficial.

### Wiki

A wiki é um conjunto de conceitos Markdown aprovados. Cada conceito deve ter identidade estável, título, descrição, tipo local, tags, timestamps, fontes e status de revisão. Links entre conceitos usam Markdown padrão; sintaxes específicas de um editor não são necessárias.

Uma afirmação relevante deve ser verificável por uma citação no corpo ou por referências explícitas aos raws no frontmatter. A wiki pode registrar conflitos sem forçar consenso artificial.

### Output

Outputs são consultas, relatórios e análises derivados da wiki. Toda resposta relevante pode ser arquivada com os conceitos que a informaram. Um output durável pode originar uma nova proposta de conceito.

### Bundle OKF

Um bundle é uma projeção derivada, hierárquica e descartável. Ele contém apenas conceitos aprovados selecionados para um projeto ou finalidade. O caminho do arquivo é a identidade do conceito dentro do bundle.

O compilador:

1. resolve a seleção declarada pelo projeto;
2. inclui dependências explícitas quando configurado;
3. converte metadados internos para frontmatter OKF;
4. gera links Markdown portáteis;
5. gera `index.md` para descoberta progressiva;
6. gera `log.md` com histórico da projeção;
7. valida OKF v0.1;
8. grava um manifesto de proveniência da compilação.

## Identidades

- `source_id`: hash estável da origem canônica e do conteúdo capturado.
- `concept_id`: identificador estável independente do título visível.
- `proposal_id`: identificador de uma execução de compilação.
- `bundle_id`: identificador da definição de uma projeção.
- `build_id`: identificador de uma compilação concreta do bundle.

Renomear um conceito não deve quebrar seu histórico interno. O compilador de bundle mantém um mapa entre `concept_id` e caminho OKF.

## Organização por tópicos e projetos

Tópicos guardam conhecimento reutilizável por assunto. Projetos guardam decisões, arquitetura, convenções e contexto exclusivos de um repositório ou iniciativa. Um projeto pode referenciar vários tópicos e excluir conceitos específicos.

Conhecimento não é copiado para um projeto durante a edição. Cópias aparecem somente em bundles gerados e podem ser reconstruídas.

## Ciclo de vida

```text
capturado -> normalizado -> aguardando compilação
-> proposta -> aprovado/rejeitado -> indexado
-> selecionado -> compilado em OKF
```

Conteúdo aprovado pode ser marcado como superseded ou archived, mas não é apagado silenciosamente. Raws são imutáveis; uma nova captura gera uma nova versão ligada à anterior.
