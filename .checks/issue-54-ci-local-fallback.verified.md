# Issue 54 — verificação independente final

Veredito: **PASS**, C1–C7. Profile: **light**.
Verifier: /root/verify_sheldon_ci_local_fallback, subagente independente e somente leitura.
Base: 3b8df2b3f9c8eefb6a6c46a59ce7acc7c54b7c36.
HEAD de implementação: 428e1f7ff580408a470d150ecb9d8ce0745ecc72.

Este arquivo transcreve o relatório independente final. O commit deste relatório
não muda a implementação examinada.

## Resultado

O Verifier reexecutou as provas completas após a correção F1:
**126 testes aprovados, 3 skips preexistentes, 0 falhas, 11 arquivos, exit 0.**
Os skips pertencem aos testes antigos de symlinks em build-npm-packages.test.ts;
não foi acrescentado skip para esta entrega.

Fontes lidas: issue 54, task/checklist, AGENTS.md, CONTRIBUTING.md e runbooks.
Fontes inalteradas foram carregadas da verificação inicial eff37a9; o diff da
correção e as provas completas foram reconferidos em 428e1f7.

| Check | Resultado e assertion localizada                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1    | PASS. release-fallback.test.ts:57 não chama local em sucesso CI; :65 sequência ci/local/validate; :92 falha real prevalece. release-fallback-runtime.test.ts:287–292 verifica failed/blocked/unavailable, rejeita inspeção inconclusiva e exige inspected=true.                                                                                                          |
| C2    | PASS. release-fallback-runtime.test.ts:34–37 afirma linux/amd64, Node 24, snapshot readonly e ausência de credenciais/Mac/socket; :129 afirma verify/stage/smoke/audit/pack; :141–142 falha no verify impede staging. Adapter cria dois snapshots do mesmo HEAD.                                                                                                         |
| C3    | PASS. release-fallback-runtime.test.ts:40–44 confirma default sem publicação. release-fallback.test.ts:113–126 bloqueia main/identidade erradas; :157–166 confirma runtimes/metapacote/catálogo/promoção; :194–197 falhas impedem promoção; :212–213 exige assinatura; :227 afirma somente next em prerelease. Guards reais conferem main remota atual e versão inédita. |
| C4    | PASS. release-fallback-model.test.ts:14–19 pins exatos Mac antigos e Windows/Linux novos; :23–28 default uniforme; :36 rejeita overrides inválidos; :61–65 inventário/SHA256SUMS incluem hash do manifesto efetivo.                                                                                                                                                      |
| C5    | PASS. release-fallback-catalog.test.ts:20–26 autentica assinatura e rejeita outra chave/bytes; :54/:57 preserva Mac byte a byte; :59 rejeita versão incompatível; :71–72 rejeita hash/tamanho errado; :75–95 exclui Mac dos uploads locais.                                                                                                                              |
| C6    | PASS. release-fallback.test.ts:66–68 reporta prepared/not_verified/targets exatos; :256–261 registra falha e fases sem persistir credenciais da exception. release-fallback-runtime.test.ts:81–85 exige identidade e checksum dos tarballs.                                                                                                                              |
| C7    | PASS. Guard versionado contra a base saiu 0. release-fallback-history.test.ts:23 segundo lock rejeitado; :34–35 counters e review lock permanecem byte a byte; :36 somente lock próprio removido; :37–39 report real salvo. Documentação/alias e defaults originais preservados.                                                                                         |

## Finding F1 e correção

A rodada inicial encontrou um P1: billing no segundo dispatch retornava unavailable
sem inspecionar uma falha real do primeiro run. Quatro regressões reproduziram
o problema no código antigo e passaram após a correção.

O Verifier reproduziu o cenário novamente, sem rede nem publicação:
resultado failed, runIds=[11], jobsInspected=true. inspectRuns é usado tanto no
polling quanto no catch; erro de inspeção propaga e bloqueia.

Findings restantes: nenhum no escopo reconferido.

## Provas e gates

Comando de testes executado pelo Verifier:

```text
npx --no-install vitest run --reporter verbose scripts/release/test/release-fallback.test.ts scripts/release/test/release-fallback-runtime.test.ts scripts/release/test/release-fallback-model.test.ts scripts/release/test/release-fallback-catalog.test.ts scripts/release/test/release-fallback-history.test.ts scripts/release/test/npm-package-model.test.ts scripts/release/test/build-npm-packages.test.ts scripts/release/test/build-official-artifacts.test.ts scripts/release/test/stage-official-artifacts.test.ts scripts/release/test/verify-official-release.test.ts scripts/release/test/smoke-npm-package.test.ts
```

Também executados no HEAD final, todos exit 0:

- Prettier --check e ESLint nos formatos/arquivos afetados.
- Markdownlint nos sete Markdown alterados: zero issues.
- npm run typecheck; npm run lint:repo; npm run lint:domain.
- git diff --check BASE..HEAD.
- `git diff --exit-code BASE..HEAD -- .github/workflows scripts/code-review code-review.config.json .checks/issue-47* .tasks/issue-47*`.
- git status --porcelain vazio.

## Sweep e limitações

Versão, pins, source, identidade e hashes têm guards. Falhas reais e evidência
inconclusiva bloqueiam. Publicação exige opt-in, main atual e autenticação.
Outputs exclusivos impedem retry silencioso. Ordem, lock exclusivo, snapshots,
cleanup guardado e registros de fases parciais permanecem comprovados.

Não há Coverage/Test policy no checklist; profile light não exige comparação UI
ou fault injection. Não houve CI/dispatch/billing em produção, release completa
Windows/Docker, publicação npm/dist-tag, upload GitHub ou verificação Mac.
As provas usam fixtures/IO injetado; não são alegações de publicação real.

Não existe baseline externo dos históricos runtime reais da issue 47 nesta cópia.
Sua comparação histórica de ambiente permanece não comprovada. C7 é sustentado
pelo guard versionado, isolamento das escritas e teste do IO real preservando
counters/lock preexistentes em Git temporário; não se inventou baseline.

A revisão Codex oficial permanece uma etapa posterior a este relatório.
