# Release CI primeiro, fallback local — issue 54

## Intenção e autorização

O proprietário decidiu em 2026-10-14 tentar a CI e, quando indisponível, executar
o fluxo automaticamente na máquina local. Windows e Linux são verificados e
publicados no fallback; macOS não é verificado nem publicado. O catálogo segue
a mesma regra. O comando prepara por padrão e só publica com opção explícita.
Não executar publicação real nesta implementação.

## Limite e decisões

Preservar os workflows originais, motor comum e histórico. Reutilizar os builders,
smokes, assinatura e verifier de catálogo. A opção nova de versões macOS no
builder de metapacote conserva o caminho padrão de versão única da CI.

- Uma CI que realmente reprova testes não vira aprovação local.
- Docker cobre Linux x64, não macOS. O fallback usa snapshots do mesmo commit.
- macOS no metapacote continua nas versões exatas anteriores confirmadas no npm.
- O catálogo local conserva bytes, hashes e versões macOS da release anterior
  autenticada pela chave pública existente. Versões incompatíveis bloqueiam
  publicação em vez de mudar o protocolo ou inventar artefatos Mac.
- Runtimes OCR podem ser reutilizados da release anterior assinada quando passam
  pelas validações de layout e fontes fixadas existentes; não refazer uma build
  nativa que não mudou. Falha dessas validações impede publicar.
- CI preferida são os workflow_dispatch de preparação de publish-npm.yml e
  release.yml, que não publicam. Fallback é por indisponibilidade, não por erro.
- Publicação opt-in exige main limpa, commit remoto atual, artefatos validados,
  autenticação npm e catálogo assinado. Nenhum tag v* é criado por este comando.
- Runtimes candidate antes do metapacote; catálogo antes da promoção next/latest.
  Falha parcial é registrada e não reusa a versão nem promove automaticamente.
- Preparação local sem chave pode gerar artefatos e informar assinatura pendente;
  --publish exige a chave original, nunca uma substituição ou credencial no repo.

## Provas

Ver .checks/issue-54-ci-local-fallback.md. Profile light; implementar com testes,
Verifier independente e revisão oficial local antes do PR.

## Exceção de revisão autorizada

Em 2026-10-14, o proprietário respondeu: "Sim, uma rodada adicional somente no Sheldon #54".

Apenas a issue 54, profile light, tem maxRounds=3. As duas tentativas anteriores
continuam na contagem; os três perfis padrão permanecem com maxRounds=2.
Nenhum workflow, motor comum ou histórico é modificado por esta exceção.
