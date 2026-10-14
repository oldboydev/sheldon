# Issue 54 — verificação independente F6

**PASS: C1–C7. F1–F6 resolvidos nas provas executadas.**

Profile: light.
Verifier independente: /root/verify_sheldon_ci_local_fallback, somente leitura.
Base: 3b8df2b3f9c8eefb6a6c46a59ce7acc7c54b7c36.
HEAD de implementação: 0fee9d3cd8b57cf3b32e0018ad6f9c8359bea028.

Relatório transcrito pelo coordenador. O commit deste arquivo altera somente
evidência documental, sem mudar o código verificado.

## Resultado e fontes

Uma invocação completa com reporter verbose: **191 testes aprovados, 3 skips
preexistentes, 0 falhas, 11 arquivos, exit 0**. Os skips pertencem aos testes
antigos de symlinks em build-npm-packages.test.ts, que não foi alterado.

Issue 54, task/checklist, AGENTS.md, CONTRIBUTING.md e runbooks foram lidos.
Fontes e análise inalterada de C2–C6 são carregadas de 428e1f7; C1/F1–F6,
snapshot contraditório, C7 e gates foram reconferidos no HEAD final.
A execução final substitui o lote de 186 testes no commit 1c40293 após o complemento de snapshot contraditório.

| Check | Evidência localizada                                                                                                                                                                                                                                                                                                                    | Resultado |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| C1    | release-fallback.test.ts:89–90 rejeita sete conclusões agregadas com billing, inclusive success contraditório. Runtime :832–833 exige failed sem cancelar; :845–846 bloqueia corrida antes do cleanup; :850–851 bloqueia success com billing após cancelar; :856 conserva owncancel com billing autenticado. F1–F5 novamente aprovados. | PASS      |
| C2    | release-fallback-runtime.test.ts:34–37 exige Docker Linux amd64, Node 24.13.0, snapshot readonly e ausência de Darwin/credenciais; :129 exige verify/stage/smoke/audit/pack; :141–142 bloqueia staging após verify reprovado.                                                                                                           | PASS      |
| C3    | release-fallback-runtime.test.ts:40–44 exige default sem publicação/opt-in; release-fallback.test.ts:122–135 bloqueia main/identidade erradas; :166–175 exige ordem de publicação; :203–206 falhas não promovem; :236 exige somente next em prerelease.                                                                                 | PASS      |
| C4    | release-fallback-model.test.ts:14–19 exige pins Mac antigos exatos e Windows/Linux novos; :23–28 preserva default uniforme; :36 rejeita mapas inválidos; :61–65 verifica inventário/SHA256SUMS do manifesto efetivo; runtime :60–64 confirma versões anteriores.                                                                        | PASS      |
| C5    | release-fallback-catalog.test.ts:20–26 autentica assinatura; :54/:57 conserva bytes/hashes Mac; :59 bloqueia incompatibilidade; :71–72 rejeita adulteração; :75–95 exclui ZIPs Darwin dos uploads locais.                                                                                                                               | PASS      |
| C6    | release-fallback.test.ts:66–68 exige prepared/Mac not_verified/targets exatos; :265–270 exige failed, fases parciais e ausência de credencial no report; release-fallback-runtime.test.ts:81–85 verifica hash/identidade/checksum.                                                                                                      | PASS      |
| C7    | release-fallback-history.test.ts:23 rejeita lock concorrente; :34–35 conserva histórico e review lock byte a byte; :36 remove só lock próprio. Guard versionado saiu 0. Config defaults 2; única exceção autorizada 54/light=10.                                                                                                        | PASS      |

## Findings corrigidos

F1: billing no segundo dispatch não elimina a evidência do primeiro run.
F2: falha de job/step é reconhecida com a matriz ainda em execução.
F3: a exceção de billing é autenticada por job; outros resultados não a herdam.
F4: verificações iniciadas, inclusive Mac, são aguardadas; filas sem execução
exigem cancelamento confirmado. Corridas e conclusões inconclusivas bloqueiam.

F5: o polling após cancelamento conserva a resposta completed e sua conclusão.
Jobs remanescentes são inspecionados juntos; apenas cancelamentos próprios de
jobs comprovadamente não iniciados recebem exceção. Falhas/pending bloqueiam.
Conclusão agregada só admite success/cancelled ou failure com billing autenticado;
unknown/null ou falha sem explicação bloqueia. Sete regressões reproduziram o
defeito antes da correção e passaram depois; success/billing permanecem aceitos.
Um complemento red-green bloqueia completed/success com jobs ainda queued.

F6: billing só justifica a conclusão agregada completed/failure. Timeout,
cancelamento externo, action_required, neutral, unknown/null e success contraditório
são bloqueados, mesmo com um job de billing autenticado. Dezoito regressões
reproduziram o primeiro defeito e passaram após a correção; quatro regressões
reproduziram a contradição success/billing no classificador e nas consultas antes
e depois do cancelamento. O cancelamento próprio de fila com billing permanece
aceito. A classificação e o guard pós-cancelamento seguem a mesma restrição.

Findings restantes nesta reconferência: nenhum.

## Provas e gates

```text
npx --no-install vitest run --silent=true --reporter verbose scripts/release/test/release-fallback.test.ts scripts/release/test/release-fallback-runtime.test.ts scripts/release/test/release-fallback-model.test.ts scripts/release/test/release-fallback-catalog.test.ts scripts/release/test/release-fallback-history.test.ts scripts/release/test/npm-package-model.test.ts scripts/release/test/build-npm-packages.test.ts scripts/release/test/build-official-artifacts.test.ts scripts/release/test/stage-official-artifacts.test.ts scripts/release/test/verify-official-release.test.ts scripts/release/test/smoke-npm-package.test.ts
```

Todos executados independentemente, exit 0:

- Prettier nos formatos suportados alterados; ESLint nos códigos alterados.
- Markdownlint nos oito Markdown alterados: zero issues.
- npm run typecheck; npm run lint:repo; npm run lint:domain.
- git diff --check BASE..HEAD; guard de workflows/core/históricos versionados.
- git status --porcelain vazio.
- Defaults 2 e única exceção 54/light=10 conferidos; histórico runtime real
  conserva cinco tentativas changes_requested, limites registrados 2/2/3/10/10.

## Sweep e limites

Sweep inalterado carregado da análise anterior, com transições, concorrência e
cancelamento reconferidos. Validação, ordenação, autorização, snapshots, outputs
exclusivos, locks e reports sem credenciais permanecem comprovados.

Não houve CI/dispatch/billing, release completa Windows/Docker, npm publish,
dist-tag, upload GitHub ou verificação Mac em produção. As provas usam fixtures/IO
injetado. Sem Coverage/Test policy no checklist; profile light dispensa fault injection.

Sem baseline externo, a comparação dos históricos runtime reais da issue 47
permanece não comprovada como evidência de ambiente. C7 passa pelo guard versionado,
isolamento das escritas e teste do IO real preservando counters/locks preexistentes.

O proprietário autorizou em 2026-10-14: "faça quantas precisar", ao pedido de quarta
revisão somente do Sheldon #54. O override usa o teto técnico suportado de 10;
defaults dos demais trabalhos permanecem 2 e todo histórico é preservado.
Este PASS não substitui aprovação oficial nem autoriza publicação ou merge.
