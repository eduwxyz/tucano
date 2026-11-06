# Celular (Telegram)
> Aprovações com botões, perguntas dos agentes e o fim das rotinas no seu Telegram, com um bot seu.

Com um bot do Telegram seu, você decide aprovações, responde às perguntas dos agentes (é só responder a mensagem) e recebe o fim das rotinas de qualquer lugar. É útil pra rotina que pede aprovação de madrugada. O app busca as mensagens no Telegram, então nada precisa chegar até o seu computador.

## Ligar
1. Em **Configurações › Celular** (Settings › Phone), card **Celular (Telegram)**.
2. No Telegram, abra o @BotFather, mande `/newbot` e escolha um nome. Ele devolve um token.
3. Cole o token em **Token do bot** e **Salvar**.
4. Abra o seu bot no Telegram e mande o código que o app mostra (`/start <código>`). Só quem mandar esse código fica com o bot.
5. Pronto: o card mostra **Pareado**.

## O que ele manda
O texto das aprovações e das perguntas (ferramenta, argumentos, motivo) e as respostas das rotinas. Uma ação de alto risco pede dois toques pra aprovar. O token fica no cofre do sistema.

## Trocar ou tirar
- **Trocar de bot**: outro token.
- **Desconectar este chat**: o bot para de mandar pra esse chat.
- **Remover bot**: tira o token.

## Workspaces
O Telegram fica no workspace padrão: dois workspaces não podem consultar o mesmo token. Nos outros, o card mostra um link pra trocar pro padrão.

## Quando dá errado
"O Telegram não respondeu": confira a internet ou troque o token do bot. Se outro app lê o mesmo bot, o Telegram recusa: use um bot só pro Tucano.
