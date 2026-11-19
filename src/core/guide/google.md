# Google: Gmail, Calendar, Drive, Docs e Sheets
> Conectar os serviços do Google: o app que a pessoa cria no Google Cloud uma vez, os 6 passos (com a inscrição no Developer Preview), o aviso de app não verificado e o que conferir quando o Google recusa.

O Google só deixa entrar apps cadastrados nele, então a pessoa cria o seu uma vez, no Google Cloud, e os cinco entram com ele. O primeiro **Conectar** num deles abre **Seu app do Google** com os passos:
1. Criar um projeto no Google Cloud.
2. Ativar as APIs (um link ativa as dez: a de cada serviço e a MCP de cada um).
3. Inscrever o projeto no **Google Workspace Developer Preview Program** (developers.google.com/workspace/preview): os servidores MCP do Google ainda estão em prévia e só atendem projetos inscritos. O formulário pede o número do projeto (no painel do projeto). A aprovação costuma levar uns dias; dá pra seguir os passos e salvar, mas até lá os conectores do Google falham.
4. Configurar a tela de login (Google Auth Platform › Começar): nome do app, e-mail, Público-alvo **Externo** (ou **Interno** numa conta Google Workspace de empresa), e o próprio e-mail em **Usuários de teste**.
5. Criar o cliente: tipo **App para computador**, com **Usar este cliente para um agente com IA** marcado. Sem essa marca o Google recusa os conectores.
6. Colar o **ID do cliente** e a **chave secreta do cliente** e clicar em **Salvar e conectar**.

Depois os outros quatro são um clique. Pra trocar de app: **Seu app do Google**, ao lado do título Google na loja; trocar desconecta os do Google, que pedem login de novo.

Com o app **em teste**, o Google pede login de novo a cada 7 dias. Pra parar: em Público-alvo, **Publicar app**; o login passa a mostrar "O Google não verificou este app", e como o app é da própria pessoa, é só clicar em **Avançado** e continuar.

Prefere não criar o app? A Composio conecta o Google sem isso, mas seus dados passam pelos servidores dela: veja **composio**.

O Gmail busca, lê, rascunha e põe marcadores, mas não envia nem apaga de vez. O Drive lê tudo e só escreve nos arquivos que criou ou abriu.

## Quando dá errado
- "...enrolled in the Google Workspace Developer Preview Program": falta o passo 3. Inscreva o projeto em developers.google.com/workspace/preview e espere uns dias. Enquanto isso, a Composio conecta sem esse passo (veja **composio**).
- **Falta o seu app do Google**: clique em **Conectar** num deles e siga os passos.
- **Precisa autorizar**: o Google só pede login numa chamada. Clique em **Autorizar**; **Conectar de novo** não abre o navegador.
- "Falta autorizar o Gmail": o login acabou (com o app em teste, a cada 7 dias). Clique em **Autorizar**.
- "Recusou o login, mesmo renovado": clique em **Autorizar** pra entrar de novo. Se continuar, confira **Usuários de teste** e o cliente (**App para computador**, com a marca de agente com IA).
- "Falta permissão no login": alguma caixa ficou desmarcada na tela do Google. **Autorize** de novo e marque todas.
- "Uma API não está ativada" (SERVICE_DISABLED): ative a API citada no mesmo projeto do cliente e espere uns minutos. Autorizar não resolve.
- Erro na página de login do Google: "access_denied" é e-mail fora de **Usuários de teste**; "org_internal", app **Interno** com conta de fora; "redirect_uri_mismatch", cliente que não é **App para computador**; "invalid_client", ID ou chave errados (troque em **Seu app do Google**).
- Pede login toda semana: o app está **em teste**; publique-o (acima).
