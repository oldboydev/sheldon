# Issue 54 — verificação independente da correção final

**PASS: C1–C7. F1, F2 e F3 resolvidos nas provas locais.**
Profile: light.
Verifier independente: /root/verify_sheldon_ci_local_fallback, somente leitura.
Base: 3b8df2b3f9c8eefb6a6c46a59ce7acc7c54b7c36.
HEAD de implementação: 8c47c2cbe1bbc48fa8bdc14c122395e7119a419e.

Relatório transcrito pelo coordenador. O commit deste arquivo altera somente
evidência documental, sem mudar o código verificado.

## Resultado e fontes

Uma invocação com reporter verbose: **139 testes aprovados, 3 skips preexistentes,
0 falhas, 11 arquivos, exit 0**. Os skips são antigos testes de symlinks em
build-npm-packages.test.ts, que não foi alterado.

Issue 54, task/checklist, AGENTS.md, CONTRIBUTING.md e runbooks foram lidos.
Fontes e análise inalterada de C2–C6 são carregadas de 428e1f7; todos os testes
foram novamente executados no HEAD final. C1, F1/F2/F3, C7 e gates foram reconferidos.

| Check | Evidência localizada                                                                                                                                                                                                                                                     | Resultado |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| C1    | release-fallback-runtime.test.ts:445–446 exige failed nos nove casos inconclusivos junto de billing no mesmo workflow; :449–458 conserva billing individual autenticado; F1 :287–292 e F2 :369–370 passaram novamente.                                                   | PASS      |
| C2    | release-fallback-runtime.test.ts:34–37 exige Docker Linux amd64, Node 24, snapshot readonly e ausência de Darwin/credenciais; :129 exige verify/stage/smoke/audit/pack; :141–142 bloqueia staging após verify reprovado.                                                 | PASS      |
| C3    | release-fallback-runtime.test.ts:40–44 exige default sem publicação; release-fallback.test.ts:113–126 bloqueia main/identidade erradas; :157–166 exige ordem runtimes/metapacote/catálogo/promoção; :194–197 falhas não promovem; :227 exige somente next em prerelease. | PASS      |
| C4    | release-fallback-model.test.ts:14–19 exige pins Mac antigos exatos e Windows/Linux novos; :23–28 preserva default uniforme; :36 rejeita mapas inválidos; :61–65 verifica inventário/SHA256SUMS do manifesto efetivo.                                                     | PASS      |
| C5    | release-fallback-catalog.test.ts:20–26 autentica assinatura; :54/:57 conserva bytes/hashes Mac; :59 bloqueia incompatibilidade; :71–72 rejeita adulteração; :75–95 exclui ZIPs Darwin dos uploads locais.                                                                | PASS      |
| C6    | release-fallback.test.ts:66–68 exige prepared/Mac not_verified/targets exatos; :256–261 exige failed, fases parciais e ausência de credencial no report; release-fallback-runtime.test.ts:81–85 verifica hash/identidade/checksum.                                       | PASS      |
| C7    | release-fallback-history.test.ts:23 rejeita lock concorrente; :34–35 conserva histórico e review lock byte a byte; :36 remove só lock próprio; :37–39 salva report real. Guard versionado contra base saiu 0.                                                            | PASS      |

## Findings corrigidos

F1: billing no segundo dispatch não elimina a evidência do primeiro run.
A inspeção é reutilizada no polling e catch; erro de inspeção bloqueia.
Quatro regressões reproduziram o defeito antes e passaram após a correção.

F2: falha de job/step é reconhecida mesmo com a matriz ainda em execução.
Três regressões reproduziram unavailable incorreto antes e agora exigem failed.

F3: inspectCiJobs analisa cada job separadamente. A exceção de billing é
autenticada para o próprio job; timeout, cancelamento, action_required, neutral,
resultado desconhecido ou step interrompido não herda a exceção de outro job.
Nove regressões falharam no código anterior e passaram; um décimo teste confirma
que billing puro com setup failure permanece aceito.

Findings restantes na reconferência: nenhum.

## Provas e gates

```text
npx --no-install vitest run --reporter verbose scripts/release/test/release-fallback.test.ts scripts/release/test/release-fallback-runtime.test.ts scripts/release/test/release-fallback-model.test.ts scripts/release/test/release-fallback-catalog.test.ts scripts/release/test/release-fallback-history.test.ts scripts/release/test/npm-package-model.test.ts scripts/release/test/build-npm-packages.test.ts scripts/release/test/build-official-artifacts.test.ts scripts/release/test/stage-official-artifacts.test.ts scripts/release/test/verify-official-release.test.ts scripts/release/test/smoke-npm-package.test.ts
```

Todos executados independentemente, exit 0:

- Prettier nos formatos suportados alterados; ESLint nos códigos alterados.
- Markdownlint nos oito Markdown alterados: zero issues.
- npm run typecheck; npm run lint:repo; npm run lint:domain.
- git diff --check BASE..HEAD.
- Guard de workflows, core/config e históricos versionados contra a base.
- git status --porcelain vazio.

## Sweep e limites

Versão, pins, source, identidade e hashes têm guards. Falhas reais e conclusões
inconclusivas bloqueiam. Publicação exige opt-in, main remota atual e autenticação.
Outputs exclusivos, ordenação, lock, snapshots e cleanup guardado permanecem
comprovados. Reports registram fases sem armazenar credenciais ou stderr.

Não houve dispatch/billing CI, release completa Windows/Docker, npm publish/dist-tag
ou upload GitHub em produção. As provas usam fixtures/IO injetado; não verificam Mac.
Não há Coverage/Test policy no checklist; profile light dispensa fault injection.

Sem baseline externo, a comparação dos históricos runtime reais da issue 47
permanece não comprovada como evidência de ambiente. C7 passa pelo guard versionado,
isolamento das escritas e teste do IO real preservando counters/locks preexistentes.

As duas tentativas do Codex oficial pediram correções. Este PASS do Verifier
comprova a correção concreta; não substitui uma aprovação oficial nem autoriza
terceira tentativa sem autorização. O proprietário autorizou em 2026-10-14
uma rodada adicional somente no Sheldon #54. A exceção local usa maxRounds=3,
com referência na task; defaults permanecem 2 e o histórico anterior é preservado.
A implementação verificada não mudou. Esta nota registra autorização humana,
não uma nova prova do Verifier nem uma aprovação do Codex oficial.
