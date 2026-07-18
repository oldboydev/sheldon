# PRD 001 — Fundação e Vault Central

## Problema

O Sheldon precisa de uma base local previsível para organizar conhecimento pessoal por tópicos e projetos. Sem um modelo estável de diretórios, identidade e estado operacional, ingestores e agentes produziriam artefatos incompatíveis.

## Objetivo

Entregar a CLI inicial, o vault central e os serviços fundamentais que todos os PRDs posteriores utilizarão.

## Usuário

Pessoa técnica no Windows, operando um único vault e uma única identidade local.

## Escopo

- Inicializar e localizar um vault.
- Criar, listar, inspecionar, renomear e arquivar tópicos e projetos.
- Manter metadados estruturados para cada tópico e projeto.
- Criar SQLite operacional separado do conhecimento.
- Oferecer configuração local e comando de diagnóstico.
- Garantir escritas atômicas e trilha de operações.
- Estabelecer comandos de lint, typecheck, testes e verificação do workspace.
- Estabelecer README, changelog e política de Conventional Commits.

## Fora de escopo

- Ingestão de fontes.
- Execução de Codex ou Claude.
- Interface web.
- Sincronização ou múltiplos usuários.

## Requisitos funcionais

1. `sheldon init` cria um vault válido em um diretório explícito ou padrão confirmado pelo usuário.
2. Um vault existente é descoberto por configuração, sem varrer indiscriminadamente o disco.
3. Tópicos vivem em `topics/<slug>` e projetos em `projects/<slug>`.
4. Cada entidade possui identificador imutável, título, descrição, data de criação, status e slug mutável.
5. Renomear altera o slug sem trocar o identificador.
6. Arquivar preserva conteúdo e histórico.
7. O banco SQLite pode ser apagado e reconstruído a partir dos arquivos quando aplicável.
8. Escritas de configuração e metadados usam arquivo temporário e rename atômico.
9. `sheldon doctor` verifica permissões, estrutura, SQLite, Node.js e disponibilidade dos CLIs.
10. Nenhuma operação requer rede ou serviço externo.
11. O workspace oferece comandos únicos para lint, typecheck, testes e verificação completa.
12. Lints de Markdown e whitespace cobrem a documentação desde o primeiro marco.
13. `CHANGELOG.md` mantém uma seção `Unreleased` e segue Keep a Changelog.
14. O README raiz descreve estado, decisões, documentação e comandos disponíveis.

## Requisitos não funcionais

- Compatível com caminhos e terminadores do Windows.
- Mensagens de erro devem indicar causa, alvo e ação de recuperação.
- Comandos de leitura não alteram arquivos.
- Operações repetidas devem ser idempotentes ou falhar sem efeitos parciais.

## Critérios de aceitação

- Dado um diretório vazio, `sheldon init` produz um vault reconhecido por uma nova execução.
- Dado um título com espaços e acentos, o sistema gera slug seguro sem perder o título original.
- Dado um tópico existente, uma segunda criação com o mesmo slug não sobrescreve conteúdo.
- Após renomear um tópico, seu identificador e histórico permanecem iguais.
- Após remover o SQLite operacional, `sheldon doctor` explica como reconstruí-lo sem perda de wiki ou raws.
- Uma falha simulada durante escrita não deixa arquivo final parcialmente gravado.
- Um commit fora do padrão Conventional Commits é rejeitado pela validação configurada quando hooks ou CI estiverem ativos.
- A verificação completa falha quando lint, typecheck, teste ou lint de domínio obrigatório falha.
- Uma mudança pública sem atualização do changelog ou README é detectada pelo checklist de contribuição e pela revisão.

## Dependências

Nenhuma. Este PRD inaugura o projeto.

## Riscos

- Permissões e bloqueios de arquivos no Windows.
- Slugs conflitantes após normalização.
- Misturar configuração operacional com conteúdo versionável.

## Métricas de sucesso

- Inicialização e diagnóstico concluídos sem acesso à rede.
- Zero perda de conteúdo nos testes de falha atômica.
- Todos os cenários de identidade e colisão cobertos por testes.
