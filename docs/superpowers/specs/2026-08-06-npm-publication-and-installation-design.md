# Design — Distribuição pública pelo npm

## Decisão de distribuição

O monorepo não será publicado. A distribuição terá um metapacote público
`@oldboydev/sheldon` e quatro runtimes de implementação, publicamente instaláveis, com a mesma
versão:

| Pacote | `os` | `cpu` | Responsabilidade |
| --- | --- | --- | --- |
| `@oldboydev/sheldon` | qualquer | qualquer | binário, seleção e diagnóstico |
| `@oldboydev/sheldon-win32-x64` | `win32` | `x64` | CLI e Job Object nativo |
| `@oldboydev/sheldon-linux-x64` | `linux` | `x64` | CLI e supervisor POSIX |
| `@oldboydev/sheldon-darwin-x64` | `darwin` | `x64` | CLI e supervisor POSIX Intel |
| `@oldboydev/sheldon-darwin-arm64` | `darwin` | `arm64` | CLI e supervisor POSIX Apple Silicon |

O metapacote declara os quatro runtimes como `optionalDependencies`, cada um com `os` e `cpu`
restritos. Seu launcher resolve somente a combinação local. Ausência ou inconsistência gera
diagnóstico estável; não há download em tempo de execução, cross-build nem fallback.

## Conteúdo do runtime

Um builder cria um diretório de staging por alvo fora dos workspaces e produz o `package.json` final.
Ele inclui os `dist` da CLI e de cada módulo interno, a closure de dependências de produção, a chave
do catálogo e os recursos de runtime necessários. A cópia é plana, sem symlinks, e valida
containment, tipo regular e hashes antes de `npm pack`.

O runtime Windows é montado no runner Windows após compilar o addon N-API. Os runtimes POSIX são
montados e verificados no alvo nativo, preservando permissões executáveis. O builder rejeita addon,
executável ou arquivo de plataforma diferente do alvo.

Os pacotes internos `@sheldon/*` continuam privados: no staging eles são dependências empacotadas,
não contratos npm suportados. O manifesto do runtime usa `bundledDependencies` somente para essa
closure explicitamente inventariada; dependências transitivas de desenvolvimento são excluídas.

## Versão e promoção

Uma única versão vem da tag `vX.Y.Z`; o workflow confere a igualdade com os cinco manifestos
gerados. Tags SemVer estáveis promovem `latest`; pré-lançamentos promovem `next`. A ordem é:

1. executar gates e construir cada runtime nativamente;
2. inspecionar e instalar cada tarball em prefixo e vault temporários;
3. publicar os quatro runtimes com o dist-tag candidato;
4. publicar o metapacote como único passo de promoção;
5. anexar hashes, SBOM e notas ao GitHub Release.

Npm não permite reutilizar uma versão. Se uma publicação parcial falhar, a recuperação usa uma nova
versão ou uma revisão explícita de dist-tags; o metapacote não é publicado enquanto faltar runtime.

## Publicação e segurança

O pacote no npm é configurado uma vez com trusted publisher apontando para
`oldboydev/sheldon` e `.github/workflows/publish-npm.yml`. O workflow usa runner hospedado,
`id-token: write`, permissões mínimas e Node 24 com npm compatível com OIDC. A URL `repository` em
cada manifesto publicado é exatamente a do repositório público. Tags e ambiente de release usam
proteção de GitHub.

Não há `NPM_TOKEN` de escrita no repositório, nos artefatos ou nos logs. Um publish manual é apenas
procedimento de recuperação com 2FA e conta mantenedora, nunca o caminho normal.

## Verificação

Além do gate normal, a release executa por alvo: lista permitida de arquivos, hash/SBOM, instalação
do `.tgz` em prefixo vazio, `sheldon --help`, `sheldon init` e um smoke do supervisor. O teste usa
o binário instalado, não `npm run sheldon` no checkout. A matriz de M10 continua como requisito
independente e os smokes de pacote não a substituem.

## Não objetivos

Esta decisão não cria pacote Homebrew, winget, MSI/PKG ou binário sem Node. Também não transforma os
workspaces internos em SDK público nem tenta simular macOS em Docker.
