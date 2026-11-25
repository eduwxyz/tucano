# Microsoft: Outlook, OneDrive, Teams e SharePoint
> Conectar uma conta da Microsoft: Outlook.com (pessoal) ou Microsoft 365 (trabalho ou escola), o login por código, o app da Softeria, o que a empresa pode exigir e o que fica de fora.

Na loja de **Conectores**, categoria **Microsoft**:
- **Outlook.com**: uma conta pessoal. E-mail, agenda, OneDrive, Excel, To Do e contatos.
- **Microsoft 365**: uma conta de trabalho ou escola. O mesmo, mais chats e canais do Teams, SharePoint e horários livres pra reunião.

Os servidores MCP da própria Microsoft só aceitam apps registrados antes (e pedem a licença do Copilot), então os dois usam o servidor de código aberto da Softeria, que já vem dentro do Tucano: não precisa instalar nada. Ele roda no seu computador e fala direto com a Microsoft: os dados não passam por mais ninguém.

## Login
Na primeira vez que um agente usar, ele te passa um link da Microsoft e um código. Abra o link, digite o código e entre na conta. A tela da Microsoft mostra o app da **Softeria** pedindo acesso a e-mail, agenda, arquivos e tarefas: é o app desse servidor. Um agente que só tem leitura também consegue fazer esse login. Depois, o acesso fica guardado neste computador, cifrado, com a chave no cofre do Tucano, e se renova sozinho. Cada conector tem o seu: a conta pessoal e a do trabalho não se misturam, e remover o conector apaga o login dele.

## Na empresa
Muita empresa só deixa entrar apps aprovados. Se a Microsoft disser que precisa de aprovação de um administrador, um admin aprova o app da Softeria uma vez no Entra ID, ou registra um app da própria empresa e você adiciona o servidor à mão, com o Client ID dele (**MS365_MCP_CLIENT_ID**).

## O que vem, e o que fica de fora
O servidor tem mais de 200 ferramentas; o conector traz uma lista curta das úteis, pra não pesar em cada resposta do agente. Na página do conector dá pra desligar as que não quiser.
- **Mandar e-mail** passa por um rascunho: o agente escreve, e enviar o rascunho pede a sua aprovação. Apagar também.
- **Canais do Teams**: o agente vê os times e canais e pode mandar mensagem, mas não lê o que foi dito nos canais. Ler pede uma permissão que só o admin da empresa libera, e ela travaria o login de todo mundo. Os chats ele lê.

## Se não funcionar
- **Precisa de aprovação do administrador**: veja **Na empresa**, acima.
- **Conta errada**: peça ao agente pra sair (logout) e entrar de novo.
