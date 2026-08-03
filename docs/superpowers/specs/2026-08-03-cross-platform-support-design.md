# Design — Suporte efetivo a Linux e macOS

## Decisão de suporte

Uma plataforma só é suportada quando possui artefato oficial, testes de aceitação, gate CI e
diagnósticos documentados. A primeira matriz é Windows x64, Ubuntu 22.04 x64, macOS arm64 e macOS
x64. Linux arm64 e Windows arm64 permanecem fora da matriz; o instalador deve reportar
incompatibilidade, nunca escolher um artefato aproximado.

## Diretórios operacionais

Separar configuração de estado mutável evita tratar `$HOME/.config` como depósito universal:

| Categoria                    | Windows                    | Linux/macOS                                 |
| ---------------------------- | -------------------------- | ------------------------------------------- |
| configuração                 | `%APPDATA%\\Sheldon`       | `${XDG_CONFIG_HOME:-~/.config}/sheldon`     |
| estado e registro de plugins | `%APPDATA%\\Sheldon`       | `${XDG_STATE_HOME:-~/.local/state}/sheldon` |
| temporários                  | área exclusiva da operação | área exclusiva da operação                  |
| vault padrão                 | `~/Documents/Sheldon`      | `~/Documents/Sheldon`                       |

O resolvedor recebe ambiente, home e plataforma como dependências testáveis. No Windows ele conserva
o layout atual. Em POSIX ele cria diretórios com permissões do usuário e não aceita `XDG_*` relativo.
Uma migração explícita copia o estado antigo, valida hashes e somente então troca o ponteiro; vaults
nunca são movidos automaticamente.

## Ciclo de vida POSIX

No Windows, o supervisor e Job Object continuam sendo a implementação autoritativa. Em POSIX, o
launcher cria o plugin em sessão/grupo próprio (`detached`) e conserva o identificador do grupo
somente após confirmar o PID do processo filho. O término segue esta sequência:

1. cancelar o protocolo e fechar stdin quando aplicável;
2. enviar `SIGTERM` ao grupo do plugin;
3. aguardar o grace period limitado e drenar apenas as caudas já permitidas;
4. enviar `SIGKILL` ao mesmo grupo se ainda existir;
5. aguardar `close`, encerrar lease e registrar o diagnóstico estável.

Os helpers recusam PID não positivo, nunca usam grupo do host e toleram `ESRCH` apenas depois de
confirmar que o processo já saiu. Testes usam um pai que cria descendente, outro que sai deixando o
descendente com pipes, e cancelamento durante a inicialização.

## Empacotamento e runtimes

O catálogo mantém quatro artefatos distintos por plugin. O builder executa runtimes apenas no alvo,
preserva permissões `0755` para executáveis POSIX e rejeita arquivos extras ou runtime de outra
plataforma. A promoção macOS exige assinatura e notarização verificáveis antes de publicar o ZIP;
falha de credencial de assinatura bloqueia somente a promoção, nunca induz o usuário a enfraquecer
Gatekeeper.

Linux é construído e testado contra Ubuntu 22.04 x64. macOS é validado em Intel e Apple Silicon. A
verificação do release instala em raiz limpa, executa `describe` e `healthcheck`, e roda smoke dos
runtimes OCR e yt-dlp que pertencem ao artefato.

## CI

O gate unificado é uma matriz de Windows, Ubuntu e macOS em cada PR. A cobertura não pode ser
agregada entre sistemas para esconder uma falha: cada job deve atingir os thresholds do projeto. O
job macOS de PR cobre a arquitetura disponível de modo nativo; os dois smokes de artefato (Intel e
Apple Silicon) são obrigatórios em release e agendados. O release depende de todos eles e não
sobrescreve o catálogo quando um alvo falhar.

## Ondas de implementação

1. Criar resolvedor de diretórios e testes de XDG/migração, sem mudar o layout Windows.
2. Introduzir launcher e terminador de grupo POSIX; adicionar os testes de descendentes antes de
   declarar paridade.
3. Tornar registry, instalação e diagnósticos independentes de separador, case e utilitários
   Windows; exercitar ZIP e plugins em raiz com espaços.
4. Converter CI em matriz e adicionar smokes reais de artefato/runtimes por alvo.
5. Adicionar assinatura/notarização macOS, guia de instalação e checklist de release; só então alterar
   a política de suporte e o roadmap.

## Não objetivos

Não há sandbox de privilégio, sincronização de vault ou expansão de conectores nesta entrega. O foco
é equivalência operacional e verificável do núcleo já existente.
