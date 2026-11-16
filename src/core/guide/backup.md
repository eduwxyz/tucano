# Time, importação e backups
> Exportar e importar o time num arquivo .md, trazer agentes do OpenBot, do Grok Bot ou do Hermes, e os backups do banco.

Fica em **Configurações › Geral** (Settings › General).

## O time num arquivo
No card **Time** (Team):
- **Exportar time**: baixa um .md com os agentes, as skills, os canais e as rotinas, sem credenciais nem conversas. Serve pra guardar ou levar pra outro computador. O Tuca não vai junto: cada instalação tem o seu.
- **Importar time…**: lê um .md exportado. Entra só o que ainda não existe aqui; as rotinas entram desligadas. No fim aparece um resumo do que entrou e do que ficou de fora.

## De outro app
**Importar de outro app…** aceita um .zip:
- **OpenBot**: em Configurações do servidor → Transfer → Export from this server, com os arquivos.
- **Grok Bot**: ele não exporta sozinho. **Skill pro Grok Bot (experimental)** baixa uma skill: dê ela a um dos seus agentes de lá (ou cole o texto numa conversa) e peça "Exporte meus agentes pro Tucano". Ele devolve um .zip. É experimental: confira o resumo da importação.

## Do Hermes
**Importar do Hermes…** lê a pasta do Hermes Agent neste computador (`HERMES_HOME` ou `~/.hermes`, ou outra que você escolher) e mostra o que vem antes de importar. Cada perfil vira um agente; com vários, você escolhe.
- **Vem:** o `SOUL.md` como instruções, as memórias dele e as suas (`USER.md`), as skills que você criou ou instalou, as que vieram com o Hermes e você editou, e as tarefas agendadas que cabem numa rotina daqui.
- **Só o nome, no resumo:** servidores MCP, Telegram/Discord/Slack, tarefas de horário sem equivalente (a cada 30 minutos, várias horas por dia) e o modelo.
- **Nunca:** `.env`, `auth.json`, conversas, histórico, logs e as skills que vieram com o Hermes sem mudança. Um link dentro da pasta do Hermes não é seguido.

Os agentes importados entram sem nenhum conector, com a busca na web desligada, as rotinas desligadas e as memórias esperando você confirmar. Um servidor MCP do outro app só aparece no resumo; nunca vira conector sozinho.

## Backups
No card **Área de perigo** › **Backups**:
- O app faz uma cópia do banco uma vez por dia e guarda as últimas 7.
- **Fazer backup agora** faz uma na hora. **Abrir pasta** mostra onde ficam.
- Antes de uma atualização mudar o banco, o app também guarda uma cópia.
- As credenciais ficam cifradas no backup, presas ao cofre deste computador.

Cada workspace tem os seus backups, dentro da pasta dele: excluir um workspace apaga os backups dele. Copie pra fora antes.

## Quando dá errado
- "Arquivo grande demais pra mandar pelo navegador" (no servidor): importe no app do computador, ou exporte sem os arquivos.
- Importei e nada mudou: tudo já existia aqui (o resumo diz isso).
- "Não parece uma pasta do Hermes": escolha a pasta do Hermes, a que tem o `SOUL.md` e a pasta `memories` (no servidor, é a pasta do servidor). Uma pasta com só um `config.yaml` ou uma `skills/`, como a `~/.claude`, não conta.
