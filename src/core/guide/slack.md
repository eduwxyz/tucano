# Slack
> Conectar o Slack: o app interno que a pessoa cria a partir de um link, os 2 passos, a aprovação do admin e o que conferir quando não conecta.

O servidor MCP do Slack só aceita apps do diretório do Slack ou apps internos de um workspace. Então a pessoa cria o seu, interno, uma vez. O primeiro **Conectar** no Slack abre **Seu app do Slack** com os passos:
1. **Crie o app no Slack**: o link abre o Slack com tudo preenchido (o nome Tucano, as permissões, o endereço de volta e o MCP ligado). Escolha o workspace, **Próximo** e **Criar**.
2. Em **Basic Information › App Credentials**, copie o **Client ID** e o **Client Secret** (**Show**), cole e clique em **Salvar e conectar**. O login abre no navegador: **Permitir**.

Os agentes agem como a própria pessoa (um token de usuário): veem os canais e conversas que ela vê, e o que mandam sai no nome dela. Cada ferramenta continua passando pelas classes e aprovações do Tucano: dê acesso de escrita só a quem precisa mandar mensagens.

O login volta pela porta fixa do workspace (a dos gatilhos, 47717 no workspace padrão), que fica cadastrada no app. Num workspace novo do Tucano a porta é outra: crie outro app pelo link de lá.

Pra trocar de app: na página do conector, **Seu app do Slack**.

## Quando dá errado
- **Falta o seu app do Slack**: clique em **Conectar** no Slack e siga os passos.
- O Slack diz que o app precisa de aprovação: num workspace de empresa, o admin aprova em **Gerenciar apps**; depois, **Autorizar no navegador**.
- "redirect_uri did not match": o app foi criado com o link de outro workspace do Tucano. Crie de novo pelo link deste.
- O login não volta pro Tucano: outro programa está na porta dos gatilhos (outro Tucano aberto, por exemplo). Feche-o e autorize de novo.
