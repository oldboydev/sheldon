# Release com CI primeiro e fallback local

O caminho original por tags e os workflows de release/npm/OCR permanecem disponíveis.
O comando abaixo usa os workflow_dispatch de preparação: eles verificam e geram
artefatos, sem publicar. Se a CI estiver indisponível por cobrança ou falta de
runner na fila, o comando executa Windows x64 e Linux x64 na máquina local.
Teste reprovado, erro de autenticação, identidade ambígua ou verificação incompleta
bloqueia o fluxo.

## Preparar

Use Windows x64, Node 24.13+, npm, Git, GitHub CLI autenticado e Docker em modo Linux.
O checkout precisa estar limpo e conter um commit; a branch precisa existir no remoto
para o dispatch. Escolha uma versão SemVer ainda inédita.

```powershell
npm ci
npm run release:fallback -- --version 0.2.12
```

A versão é um exemplo: confira o registry antes de escolher. Por padrão, nada é
publicado. Não há criação de tags v*, upload de release ou promoção de dist-tags.

A CI completa fornece os quatro runtimes e o catálogo assinado. A fila sem runner
por dois minutos aciona fallback; CI em execução é aguardada por até sete horas.
Ao sair, o comando cancela somente seus próprios runs de preparação identificados
sem ambiguidade. Erro real de testes nunca vira aprovação local.

O fallback cria dois snapshots independentes do mesmo commit. Windows e Linux
executam npm ci, verify, os builders existentes, audit do pacote e smoke de instalação.
Linux usa node:24.13.0-bookworm com linux/amd64; dependências da máquina Windows,
tokens e chave de assinatura não entram no container.

O metapacote usa Windows/Linux na versão nova e mantém versões exatas dos dois
pacotes macOS previamente publicados, confirmadas no npm. macOS fica marcado como
não verificado e não recebe publicação nova. O build original conserva a versão
uniforme por padrão.

## Catálogo

O catálogo segue a mesma tentativa de CI e fallback. Localmente, a release anterior
é autenticada com release/official-catalog-public.pem e passa pelo verifier existente.
OCR reutilizado precisa passar pelas validações de layout e modelos fixados; yt-dlp
usa o preparador existente. Windows e Linux executam os smokes nativos.

Os ZIPs macOS existentes são conservados byte a byte, com seus hashes. O protocolo
do catálogo exige a mesma versão de plugin por plataforma: se uma versão de plugin
com suporte a Mac mudou, o fallback bloqueia a publicação até haver artefatos Mac
compatíveis pela CI. Não se muda o schema para contornar essa incompatibilidade.

A preparação sem chave privada gera catálogo pendente de assinatura. Para publicar,
a chave original SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM precisa estar no ambiente.
Nunca gere outra chave nem salve a chave em arquivos versionados.

## Publicar uma release autorizada

Somente na main limpa, no commit remoto atual, com autenticação npm válida e a chave
original disponível:

```powershell
npm run release:fallback -- --version 0.2.12 --publish
```

Esse comando prepara e publica na mesma execução. Se já preparou a mesma identidade,
preserve os artefatos para inspeção e escolha uma nova versão; ele não reutiliza
automaticamente diretórios anteriores. Não execute sem autorização para a release.

A publicação verifica todos os artefatos e que nenhuma versão existe. Primeiro publica
runtimes como candidate; depois o metapacote e o catálogo; só então promove next
(prerelease) ou latest. No fallback, nenhum pacote ou ZIP Mac é publicado; os hashes
dos ZIPs Mac remotos são reconferidos antes das escritas.

O npm local usa sua autenticação habitual e as regras de 2FA do registry. Não simula
OIDC nem gera uma alegação de provenance da CI. As configurações npm não são alteradas.

## Falhas e evidência

release/local-fallback/report.json registra a última execução; cada diretório
versão-commit preserva seu próprio report e artefatos. O report contém commit, versão,
rota, runs CI, targets verificados, status macOS, hashes e cada fase da publicação.
Credenciais e stderr não são armazenados nele.

Qualquer falha interrompe as próximas fases e registra failed. Publicações npm e
uploads GitHub não são uma transação atômica: uma falha pode deixar candidates ou
parte dos assets publicados. A promoção só começa depois do catálogo; uma falha
durante promoção também pode deixar tags parciais. Inspecione o report e o registry;
não repita a versão nem promova manualmente sem analisar a falha.

O lock próprio fica no Git comum como release-fallback.lock. Temporários são removidos
ao terminar; artefatos e reports são preservados. Após interrupção abrupta, confira
o processo e o report antes de remover um lock órfão. Não apague locks de outros
agentes nem históricos de code review.

Merges mantêm PR obrigatório, revisão local e merge humano; CI é informativa.
Nenhuma release é acionada automaticamente pelo merge desse PR.
