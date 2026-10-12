# Issue 46 — Governança e revisão local

Sources:

- Conversa: “eu tenho o repo sheldon e skill-me faça as configs de governança neles tbm”.
- Sheldon: “Grok implementa; Codex local revisa antes do PR”; Claude preparado como alternativa.
- Sheldon: “no sheldon tem os CI para deploy e publish isso não pode ser alterado”.
- Issue: https://github.com/oldboydev/sheldon/issues/46.
- Referência aprovada: ERP dd031d6b1bd9bbd29a8bd2c049f284923af4da45, scripts/code-review/.

## Out of scope

Preservar os quatro workflows atuais e seus scripts/aliases de qualidade, release e publicação. Um novo workflow governa apenas esta infraestrutura; não substitui os três checks verify.
Sem aplicação, merge, deploy, publicação ou alteração de configuração global.

## Landing

- Reutilizar scripts/code-review integralmente; configuração light/ui/direct, duas tentativas.
- AGENTS contém política única; CLAUDE importa AGENTS. Grok usa AGENTS nativamente.
- CI separado com helpers já usados nos pilotos; em Sheldon todos os workflows antigos permanecem.
- Testes node:test rodam em runner próprio; Vitest preserva os testes anteriores e não coleta os novos de Node.

## Checks

### S1 — Governança e entrega · ~100 KB · ~25k tokens

**C1** — Formulários/PR e regras locais satisfazem os critérios 1–3 e configuração tem teto 2, sem overrides.
Proof: validação YAML/JSON e leitura das instruções pelo Verifier, com paths/linhas e campos explícitos.

**C2** — Os cinco blobs do motor são iguais à referência ERP aprovada.
Proof: comparação SHA-256 dos arquivos scripts/code-review em ambos consumidores e na referência.

**C3** — Relatório inválido, contexto ausente, falha, revisão stale, auth API ou mutação não aprovam.
Proof: npm run test:code-review — C1/C2/C3/C4/C5/C8/C9 individuais.

**C4** — Cache/contagem/lock não são reiniciados entre worktrees; limite e remotos são conferidos.
Proof: npm run test:code-review — C5/C6/C7 individuais.

**C5** — Seleção docs/código e resultado CI falham fechados, incluindo exclusão/renome e eventos inválidos.
Proof: npm run test:governance — quatro provas comportamentais de filtro/diff/eventos/resultado e prova do assembly workflow.

**C6** — Workflows atuais do Sheldon, scripts de release, aliases de qualidade e fontes de aplicação permanecem preservados.
Proof: git diff --exit-code d99fb462bd4d5611f02e34f36ee61b16da8bb3d4 -- .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/publish-npm.yml .github/workflows/build-ocr-runtime.yml scripts/release apps packages.
Proof: comparação dos aliases originais em package.json; novos aliases não substituem os anteriores.

**C7** — Repo/issue vinculados ao Project existente; ruleset active exige PR e CI strict sem bypass/force/delete.
Proof: gh project/issue/ruleset — consultar a configuração efetiva e citar IDs/checks/status.

## Swept

validation: C1/C3; failure modes: C3/C5; idempotency: C4/C7;
authorization: C7; concurrency: C4; lifecycle: C4;
dependency failure: C3/C5; transitions: C1/C7; observability: C1/C5.

## Handoff

Uma única implementação, abaixo de 150k; Verifier independente cobre a entrega inteira.
