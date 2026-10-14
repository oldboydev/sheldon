# Checks — fallback de release, issue 54

Profile: light.

## Fontes

- Issue 54 e decisões do proprietário nesta conversa (binding).
- AGENTS.md, CONTRIBUTING.md, runbooks e scripts atuais (binding).
- Workflows existentes: defaults preservados.
- Docker não executa macOS: macOS omitido do fallback por decisão explícita.

## Out of scope

Publicação real, push de tags, merge, mudança do protocolo de catálogo,
geração/rotação de chaves, novos servidores e alterações de produto.
Nenhuma nova IA ou revisão é executada pelo controlador.

## Landing

Novo controlador e adaptadores scripts/release/release-fallback*.mjs, testes
de contrato, README/changelog/runbooks, aliases npm, ignores de artefatos e
instruções AGENTS.md. Dois builders existentes recebem opção aditiva de pins
macOS; default conserva comportamento. Workflows e core comum não mudam.

Prova adicional de preservação: release-fallback-history.test.ts usa o lock e
report IO reais em Git temporário com counters e lock de review pré-existentes.
Nenhuma mudança na barra C1–C7.

## Checks

- [ ] C1 CI preferida é de preparação do mesmo commit/versão; indisponibilidade
      aciona local, sucesso usa CI. Falha real, publicação iniciada ou identidade
      ambígua bloqueia sem publicação local.
      Proof: npx --no-install vitest run scripts/release/test/release-fallback.test.ts
      Assert: estados ready/unavailable/failed/blocked, prioridade de falha real.
- [ ] C2 Fallback usa verify/build/smoke existentes em Windows e Linux/Docker,
      snapshots do mesmo commit e saída separada; não usa Mac local.
      Proof: testes do adaptador local e leitura dos comandos/guards.
      Assert: verify antes de pack/smoke, --platform linux/amd64 e imagem Node 24,
      falha em cada etapa impede publicação. Sem alegar execução em macOS.
- [ ] C3 Publicação é opt-in, main atual e versão inédita; candidate runtimes
      precedem metapacote e catálogo; next/latest somente depois de todos passarem.
      Proof: npx --no-install vitest run scripts/release/test/release-fallback.test.ts
      Assert: ausência de publicação por default, guard de main/HEAD, ordem e
      parada nas falhas. Nenhum tag remoto é criado.
- [ ] C4 Metapacote aponta Windows/Linux novos e macOS anteriores confirmados;
      default de cinco pacotes uniformes e inventários do staging ficam íntegros.
      Proof: npx --no-install vitest run scripts/release/test/release-fallback-model.test.ts scripts/release/test/npm-package-model.test.ts scripts/release/test/build-npm-packages.test.ts
      Assert: pins exatos, rejeição de mapa inválido e preservação de default;
      inventário/SHA256SUMS incorpora o manifesto efetivo.
- [ ] C5 Catálogo prefere CI; local conserva Mac autenticado e reusa helpers
      de assinatura/refresh/verify. Incompatibilidade ou adulteração bloqueia.
      Proof: npx --no-install vitest run scripts/release/test/release-fallback-catalog.test.ts
      Assert: Mac permanece byte a byte, versão incompatível/arquivo incorreto
      recusado, somente assets Windows/Linux e metadados entram na publicação local.
- [ ] C6 Report identifica commit, versão, rota, targets, hashes e Mac não
      verificado. Falha parcial registrada; credenciais não entram no report.
      Proof: npx --no-install vitest run scripts/release/test/release-fallback.test.ts
      Assert: campos declarados e status nas falhas, sem reutilização silenciosa.
- [ ] C7 Workflows/core/históricos permanecem iguais e documentação/aliases
      refletem CI informativa e fallback opt-in sem publicação real.
      Proof: git diff --check; lints/format/typecheck afetados; guard de workflows/core.
      Assert: defaults antigos preservados, sem --provenance/OIDC falsos no local.

## Sweep

Validação: versão, pins, artefatos e source. Falhas: fail closed, sem fallback de
teste vermelho. Idempotência: versão inédita, sem retry de publicação parcial.
Autorização: --publish e main atual; sem mudanças de credenciais. Concorrência:
lock próprio e snapshots isolados. Ordenação: runtimes/metapacote/catálogo/promote.
Lifecycle: outputs ignorados e temporários guardados; não apaga histórico.
Dependências externas: indisponibilidade distinguida de defeito e erro de auth.
Transições e observabilidade: report escrito antes e após side effects.

## Limites de prova

Testes do controlador não publicam nem alteram chaves reais. CI/produção não são
alegadas como executadas em mock. Profile light não exige injeção de faltas ou
matriz UI; as provas afetadas continuam obrigatórias.
