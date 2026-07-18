# Contribuindo com o Sheldon

## Commits

Use Conventional Commits no formato:

```text
type(scope): descrição no imperativo
```

Tipos permitidos inicialmente:

- `feat`: comportamento novo;
- `fix`: correção de comportamento;
- `docs`: documentação;
- `refactor`: mudança interna sem alterar comportamento;
- `test`: testes;
- `build`: build ou dependências;
- `ci`: automação;
- `chore`: manutenção que não cabe nos tipos anteriores;
- `perf`: desempenho;
- `revert`: reversão.

Breaking changes usam `!` após o tipo ou scope e uma seção `BREAKING CHANGE:` no corpo.

## Changelog

Toda alteração relevante para usuário, operador, plugin ou integrador atualiza `CHANGELOG.md` em `Unreleased` no mesmo commit. Alterações puramente internas podem ser omitidas somente quando não mudam comportamento, compatibilidade, instalação, segurança ou operação.

## READMEs

Toda mudança em comportamento, comandos, configuração, dependências, instalação, arquitetura pública, protocolo de plugin ou estrutura de documentação atualiza o README correspondente no mesmo commit.

O autor deve revisar o README mesmo quando concluir que não há alteração textual necessária. Quando existirem READMEs por app, package ou plugin, atualize o arquivo mais próximo da mudança e mantenha o README raiz coerente com o estado do produto.

## Gates de qualidade

Antes de concluir uma mudança, execute todos os gates aplicáveis:

1. formatação de TypeScript, JavaScript, JSON e arquivos suportados;
2. lint de código;
3. `tsc --noEmit` ou typecheck equivalente do workspace;
4. lint de Markdown;
5. testes unitários e de contrato afetados;
6. testes end-to-end quando o fluxo público mudar;
7. `git diff --check`;
8. lints de domínio aplicáveis: vault, wiki, plugin e OKF.

O scaffold da implementação definirá comandos únicos de workspace, como `npm run lint`, `npm run typecheck`, `npm test` e `npm run verify`. Até lá, documentos devem passar pela verificação de whitespace e pela revisão de links, headings e placeholders.

## Definição de pronto

Uma mudança só está pronta quando:

- critérios de aceitação relevantes estão cobertos;
- testes e lints aplicáveis passam;
- `CHANGELOG.md` foi atualizado quando necessário;
- README correspondente foi revisado e atualizado;
- documentação técnica acompanha contratos alterados;
- o commit segue Conventional Commits;
- não há segredos, artefatos temporários ou saídas geradas indevidas no diff.
