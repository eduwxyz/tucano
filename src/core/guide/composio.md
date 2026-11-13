# Composio: centenas de apps por um terceiro
> O conector da Composio: o que ele dá, o preço em privacidade (seus dados passam pelos servidores dela), como conectar e por que cada ação pede aprovação.

A Composio liga agentes a centenas de apps (Google, Notion, HubSpot, Salesforce…) sem configurar nada: sem app no Google Cloud, sem token. Fica na loja, em **Negócio e dados**.

## O preço: seus dados passam pela Composio
Nos outros conectores, os dados vão direto do serviço pro seu computador. Na Composio não:
- Tudo o que os agentes leem e mandam (e-mails, planilhas, documentos) passa pelos servidores dela.
- O acesso às suas contas (Google, Notion…) fica guardado com a Composio, não no seu computador.
- Ela registra cada chamada, com o que foi pedido e o que voltou, e diz guardar por até 1 ano. O Tucano não controla isso.

Pra nada passar por terceiros, use os conectores diretos (pro Google, veja **google**). A janela de conectar e a página do conector repetem o aviso.

## Conectar
1. Em **Conectores**, **Conectar** na Composio. Leia o aviso e clique em **Entendi, conectar**.
2. O login da Composio abre no navegador: entre ou crie a conta (o plano grátis tem limite de chamadas por mês).
3. Dê acesso a um agente, como em qualquer conector.

As contas de cada app você liga na hora: na primeira vez que um agente precisa do Gmail, por exemplo, a Composio devolve um link de login, e o agente mostra pra você abrir.

## Ferramentas e aprovações
A Composio não mostra uma ferramenta por ação. Ela dá umas poucas que acham e rodam as ações dos apps, e o Tucano julga cada chamada pelo que ela roda:
- **COMPOSIO_SEARCH_TOOLS** e **COMPOSIO_GET_TOOL_SCHEMAS** só procuram: leitura.
- **COMPOSIO_MULTI_EXECUTE_TOOL** roda as ações que vão nos argumentos (GMAIL_FETCH_EMAILS, GMAIL_SEND_EMAIL…). Sua classe é **por chamada**: vale pela ação mais forte. Só leituras (buscar, listar, ler) rodam na hora, inclusive pra quem só tem **Ler**. Escritas (criar um rascunho) precisam de **Ler e escrever**. Sensíveis (enviar, responder, postar, apagar, rodar código) pedem aprovação, e o card mostra cada ação. Fora do formato documentado, também pede aprovação (quem só lê recebe uma recusa). O campo **account** (conta, quando há duas do mesmo app) vale.
- **COMPOSIO_PROXY_EXECUTE** manda uma requisição direta à API de um app: GET e HEAD leem (a não ser que o caminho diga uma mudança, como chat.postMessage); POST, PUT e PATCH escrevem; DELETE pede aprovação.
- **COMPOSIO_REMOTE_WORKBENCH** e **COMPOSIO_REMOTE_BASH_TOOL** rodam código nos servidores dela: sempre pedem aprovação, e quem só lê nem vê.
- **COMPOSIO_MANAGE_CONNECTIONS** liga contas: pede aprovação. Até quem só tem **Ler** a vê, e pra esse ela pede sempre.

**Aprovar e sempre permitir** num pedido do MULTI_EXECUTE vale pra cada ação sensível do pedido, sozinha (**Aprovar e sempre permitir GMAIL_REPLY_TO_THREAD**), pra aquele agente, e numa ação com **account**, só pra essa conta; nunca pro executor inteiro. Um pedido só roda sem perguntar quando todas as ações que pediriam estão permitidas. Requisições do PROXY_EXECUTE, código (mesmo chamado direto) e chamadas fora do formato nunca ficam permitidas. Pra desfazer: na página do agente, **Sempre permitido, sem pedir:**. **Alto risco** no executor exige segurar o botão e desliga o sempre permitir.

## Quando dá errado
- **precisa autorizar**: **Autorizar no navegador** e entre na Composio de novo.
- O agente manda um link da Composio: é o login de um app que ainda não está ligado. Abra, entre e peça pra ele continuar.
- A Composio parou de responder no meio do mês: veja o limite do seu plano em composio.dev.
