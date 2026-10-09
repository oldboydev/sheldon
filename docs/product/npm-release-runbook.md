# Runbook — publicação npm do Sheldon

Go-live `0.2.0` (tag `v0.2.0`) concluída em 2026-09-17. Não reutilizar versões já publicadas
(`0.1.0`, `0.1.1`, `0.2.0`, `0.2.1`, `0.2.2`, `0.2.3`, `0.2.4`, `0.2.5`, `0.2.6`, `0.2.7`,
`0.2.8`, `0.2.9`, `0.2.10`). Próxima publicação: `0.2.11` ou superior.

Tag `v0.2.2` publicou os cinco pacotes em `candidate`; `latest` ficou em `0.2.1` (promote E401).
A tag `v0.2.3` publica e promove `latest` com npm CLI 11.21.0 via OIDC. Ver Recuperação.

## Pacotes

- `@oldboydev/sheldon` (metapacote)
- `@oldboydev/sheldon-win32-x64`
- `@oldboydev/sheldon-linux-x64`
- `@oldboydev/sheldon-darwin-x64`
- `@oldboydev/sheldon-darwin-arm64`

Workflow: `.github/workflows/publish-npm.yml`  
Repositório npm `repository`: `https://github.com/oldboydev/sheldon`

## 1. Trusted publisher (bloqueia go-live)

Na organização npm `oldboydev`, para **cada** um dos cinco nomes:

1. Package settings → Trusted Publisher
2. Repository: `oldboydev/sheldon`
3. Workflow filename: `publish-npm.yml` (exato)
4. Environment: leave empty unless the workflow later adds `environment:`
5. Marque **Allow npm dist-tag** (opt-in; o publish OIDC sozinho não promove `latest`)

Pacotes de runtime que ainda 404 devem ser criados pelo primeiro `npm publish` via OIDC, ou
provisionados vazios na org antes da tag. Sem trusted publisher, o job de publish falha e
`latest` não muda.

## 2. Proteção de tag

Em GitHub: restringir quem pode criar tags `v*`. Não publicar de PR. `workflow_dispatch` só
constroi e fumaça; não chama `npm publish`.

## 3. Dry-run

Actions → Publish npm packages → Run workflow. Input version: `0.0.0-dry-run.0`.

Esperado: jobs `quality-and-m10`, `build-and-verify-runtimes`, `build-metapackage` verdes;
jobs `publish-*` e `promote-npm-packages` **não** rodam (`if: github.event_name == 'push'`).

## 4. Tag estável

```bash
git checkout main
git pull --ff-only origin main
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

Não force-push a tag. Se o workflow falhar no meio, **não** reutilize `0.2.0`. Abra `0.2.1`.

## 5. Verificar

```bash
npm view @oldboydev/sheldon version
npm view @oldboydev/sheldon dist-tags
npm view @oldboydev/sheldon-win32-x64 version
npm view @oldboydev/sheldon-linux-x64 version
npm view @oldboydev/sheldon-darwin-x64 version
npm view @oldboydev/sheldon-darwin-arm64 version
```

Esperado: todos `0.2.0`; `dist-tags.latest` = `0.2.0` no metapacote. `optionalDependencies` do
metapacote lista os quatro runtimes.

Instalação limpa (Windows x64, Node 24):

```powershell
npm uninstall --global @oldboydev/sheldon
npm install --global @oldboydev/sheldon
sheldon --help
sheldon init $env:TEMP\sheldon-install-smoke --yes
```

## 6. Depreciar o protótipo 0.1.1

Somente depois de `0.2.0` ser `latest`:

```bash
npm deprecate @oldboydev/sheldon@0.1.1 "Windows-only prototype. Install @oldboydev/sheldon@latest (0.2.0+)."
```

Não unpublish.

## Recuperação

Publicação parcial (runtimes no `candidate`, metapacote ausente): não promover `latest` à mão.
Corrigir o workflow, taguear a **próxima** versão. Dist-tag `candidate` pode ficar órfão.

Se os cinco pacotes já estão no registry em `candidate` e só faltou o promote (`E401` no
`dist-tag`), com **Allow npm dist-tag** ligado e npm CLI ≥ 11.21 no job, a próxima tag `v*`
promove sozinha. Para promover uma versão já publicada sem nova tag, na máquina autenticada:

```powershell
npm dist-tag add @oldboydev/sheldon-win32-x64@<ver> latest
npm dist-tag add @oldboydev/sheldon-linux-x64@<ver> latest
npm dist-tag add @oldboydev/sheldon-darwin-arm64@<ver> latest
npm dist-tag add @oldboydev/sheldon-darwin-x64@<ver> latest
npm dist-tag add @oldboydev/sheldon@<ver> latest
```
