# Runbook — publicação npm do Sheldon

Versão desta go-live: `0.2.0` (tag `v0.2.0`). Não reutilizar `0.1.0` / `0.1.1`.

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
Corrigir o workflow, taguear `v0.2.1`. Dist-tag `candidate` pode ficar órfão.
