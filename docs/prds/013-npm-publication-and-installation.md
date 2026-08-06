# PRD 013 — Distribuição pública pelo npm

## Problema

Sheldon é executável a partir do monorepo, mas ainda não é instalável por usuários. O workspace raiz
e a CLI são privados, usam a versão `0.0.0` e a CLI referencia pacotes internos do monorepo. Remover
`private` e publicar o diretório atual enviaria arquivos de desenvolvimento e deixaria imports
`@sheldon/*` indisponíveis fora do repositório.

## Objetivo

Publicar uma distribuição npm pública, segura e reproduzível que instale a CLI correta para Windows
x64, Linux x64, macOS x64 e macOS arm64 com um único comando e preserve a matriz M10.

## Escopo

- Pacote público de instalação `@oldboydev/sheldon` e quatro pacotes de runtime específicos de
  plataforma e arquitetura.
- Empacotamento somente de código de produção, recursos necessários à CLI e addon nativo Windows.
- Versionamento SemVer único, pré-lançamentos e canais `latest`/`next` explícitos.
- Teste de tarball e instalação limpa em cada plataforma suportada.
- Publicação a partir de tag protegida por GitHub Actions com trusted publishing npm/OIDC e
  proveniência.
- Documentação de instalação, atualização, remoção, pré-requisito Node 24 e matriz de suporte.

## Fora de escopo

- Publicar os workspaces internos `@sheldon/*` como API pública independente.
- Instaladores MSI, PKG, Homebrew, Scoop, winget ou binário sem Node.
- Suporte Linux arm64, Windows arm64, versões de Node fora da matriz ou registries privados.
- Publicar automaticamente toda alteração em `main`.

## Requisitos funcionais

1. `npm install -g @oldboydev/sheldon` instala somente o runtime compatível com `os` e `cpu`; a
   seleção nunca usa fallback de arquitetura ou sistema.
2. O pacote de entrada fornece o binário `sheldon`; em plataforma incompatível ele retorna erro
   estável com a matriz suportada e não executa artefato de outro alvo.
3. Cada runtime contém a closure exata de produção: CLI compilada, workspaces internos compilados,
   dependências de produção, catálogo/chave públicos e recursos declarados. Código-fonte, testes,
   `.git`, segredos, dependências de desenvolvimento e artefatos de outra plataforma ficam fora.
4. O runtime Windows contém o addon Job Object compatível; Linux e macOS preservam o supervisor
   POSIX. Os testes de M10 continuam passando após instalação via tarball.
5. Todos os cinco pacotes de uma versão usam o mesmo SemVer. Os runtimes são publicados antes do
   pacote de entrada, que é publicado por último; falha intermediária não promove `latest`.
6. Cada release executa `npm pack --dry-run`, inspeção de conteúdo, instalação global em prefixo
   temporário e `sheldon --help`/`sheldon init` em raiz limpa no alvo nativo.
7. O workflow de publicação só roda em tag `vX.Y.Z`, depois dos gates de qualidade e da matriz M10,
   com `id-token: write`. Nenhum token npm de escrita de longa duração é armazenado no repositório.
8. README e release notes declaram o comando de instalação, Node 24+, atualização, remoção, canais
   e limitações por plataforma.

## Critérios de aceitação

- A instalação do tarball em uma imagem Node 24 limpa no Linux executa `sheldon --help` e cria um
  vault sem depender de checkout, symlink do workspace ou `node_modules` do desenvolvedor.
- Smokes equivalentes passam em Windows x64, macOS x64 e macOS arm64, incluindo a semântica de
  supervisão apropriada ao sistema.
- A lista de arquivos de cada tarball é determinística, auditada e não contém arquivos proibidos;
  hashes e SBOM do release identificam o pacote publicado.
- Tag de pré-lançamento publica somente em `next`; tag estável publica runtimes e, por último, o
  pacote de entrada em `latest`.
- Uma tentativa de publicar com versão, repositório, plataforma ou trusted publisher divergente
  falha antes de promover o pacote de entrada.
- A documentação permite a um usuário novo instalar, atualizar, diagnosticar a plataforma e remover
  Sheldon sem consultar o monorepo.

## Dependências

- PRD 012 para a matriz de sistemas, paths e supervisores validados.
- Catálogo e artefatos oficiais já verificados para instalação opcional de plugins.
- Conta ou organização npm proprietária de `@oldboydev` e configuração manual inicial do trusted
  publisher para o workflow de release.

## Riscos e mitigações

- **Pacote monorepo incompleto:** montar staging isolado e testar o tarball instalado, nunca o
  checkout.
- **Addon Windows errado:** gerar runtime no runner Windows e bloquear publicação se o smoke nativo
  falhar.
- **Arquitetura incorreta:** usar metadados npm `os`/`cpu`, pacotes separados e diagnóstico
  fail-closed.
- **Credencial de publicação exposta:** usar OIDC trusted publishing, tag protegida e permissões
  mínimas.
- **Publicação parcial:** publicar runtimes primeiro em canal não promovido e publicar o metapacote
  somente após todas as verificações; documentar recuperação sem reutilizar versão npm.

## Métricas de sucesso

- Instalação limpa e smoke bem-sucedidos por alvo e versão.
- Zero arquivos de desenvolvimento ou segredos nos tarballs publicados.
- Zero uso de token npm de escrita de longa duração no CI.
- Tempo e taxa de sucesso de publicação por versão e plataforma.
