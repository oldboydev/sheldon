# Sheldon

Transforme arquivos, páginas e repositórios em uma base de conhecimento pessoal, local e
revisável. Sheldon organiza o conteúdo em Markdown no seu próprio disco e mantém você no
controle do que entra na wiki.

## O que você pode fazer

- Importar documentos e dados locais, preservando o original e criando conteúdo Markdown pronto
  para revisão.
- Capturar páginas públicas, fazer crawl limitado de sites públicos, registrar snapshots de
  repositórios Git locais e extrair legendas de vídeos públicos do YouTube.
- Criar uma wiki organizada por tópicos e projetos, buscar conceitos e produzir respostas com
  referências verificáveis.
- Gerar propostas com Codex CLI ou Claude Code e aprovar cada alteração antes de atualizar a wiki.
- Expor o conhecimento aprovado para Codex e Claude por MCP local, sem enviar o vault para um
  serviço remoto.

## Instalação

Requer Windows x64, Node.js 24 LTS ou superior e npm 11 ou superior.

```powershell
npm install --global @oldboydev/sheldon
sheldon --help
```

## Comece em minutos

Crie um vault local:

```powershell
sheldon init C:\knowledge\sheldon
```

Abra a interface local:

```powershell
sheldon web --vault C:\knowledge\sheldon
```

Ou trabalhe pela linha de comando:

```powershell
sheldon topic create "Aprendizado" --vault C:\knowledge\sheldon
sheldon search "prática de recuperação" --vault C:\knowledge\sheldon
sheldon doctor --vault C:\knowledge\sheldon
```

## Privacidade e funcionamento local

Seu vault é uma estrutura de arquivos Markdown sob seu controle. O MCP e a interface web operam
localmente: a interface escuta apenas em `127.0.0.1`, e o MCP usa `stdio`. Codex CLI e Claude Code
são opcionais e só são chamados quando você solicita uma ação que precisa deles.

## Atualização e suporte

```powershell
npm update --global @oldboydev/sheldon
```

Veja o código, abra uma issue ou contribua em
[github.com/oldboydev/sheldon](https://github.com/oldboydev/sheldon).
