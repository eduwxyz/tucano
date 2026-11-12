# Motores e contas
> Onde os agentes rodam: os harnesses, como entrar, contas extras, gateway da empresa e o roteador Jev.

Os agentes não têm modelo próprio: cada resposta roda num programa que você já tem no computador, chamado harness. O Tucano só lê a configuração de cada um; nunca vê nem guarda suas senhas e chaves.

## Os harnesses
Claude Code, Codex, OpenCode, Pi, Antigravity CLI, Cursor CLI, Grok, Cline CLI e Hermes. Cada um aparece em **Configurações › Modelos** (Settings › Models), no card **Harnesses**, com o estado: **Pronto**, **Falta entrar** ou **Não instalado**.

- **Instalar**: abre um terminal que instala pra você. Alguns precisam do Node.js antes.
- **Entrar**: abre um terminal com o comando de login (por exemplo `claude auth login`, `codex login`, `grok login`). Quando o login termina, o app percebe sozinho.
- **Testar** / **Mandar teste**: confere se está funcionando.
- **Verificar de novo**: procura de novo depois de instalar ou entrar.

O **Cline CLI** (`npm install -g cline`) entra num login só do Tucano: **Entrar** abre o `cline auth`, onde você escolhe a conta da Cline (no navegador) ou um provedor com a sua chave; o seu `~/.cline` não é tocado. Cada resposta roda numa pasta própria, sem as suas rules, skills, hooks, plugins e servidores MCP do Cline, e com as ferramentas de arquivo e shell do próprio Cline desligadas: o agente só usa as ferramentas do Tucano (e a web, se ele tiver). A lista de modelos mostra o último de cada provedor em que você entrou; outro vai em **Outro modelo…** como `<provedor>/<modelo>`, por exemplo `cline/anthropic/claude-sonnet-4.5`. Imagens não vão pro Cline.

Cada harness pode rodar de três jeitos, conforme você configurou: no **plano** (o login do Claude, do ChatGPT etc., sem cobrança por uso), por **chave de API** (cobrado por token) ou pelo **gateway** da empresa (o proxy que está no `settings.json` do Claude Code ou no `config.toml` do Codex). Pelo gateway, os agentes usam o mesmo e a telemetria fica desligada.

## Modelo de cada agente
Na página do agente, em **Onde roda e modelo**, você escolhe o motor e o modelo da lista dele. Se o modelo não aparece, use **Outro modelo…** e digite o nome exato. Dá pra ter um **Modelo reserva**, usado quando o principal bate no limite da assinatura.

## Contas extras
Pro Claude Code e o Codex dá pra ter mais de um login (ex.: "Trabalho"). Em **Configurações › Modelos** › **Contas**, **Adicionar e entrar**. Cada agente escolhe a conta em **Conta**. Uma conta que ainda não entrou deixa o agente sem responder até você entrar nela.

## O roteador
Em **Configurações › Modelos** › **Roteador** (Router), o modelo pequeno que lê a conversa e decide quem responde nos canais. Prefira um rápido. Uma opção é o Jev, da TypeSafe: decide em menos de 1 segundo, mas manda as últimas 10 mensagens do canal pra TypeSafe e precisa da **Chave do TypeSafe**. Se ele falhar, o Haiku decide.

## Quando dá errado
- Agente não responde e o harness diz **Falta entrar**: clique em **Entrar** e faça o login no terminal.
- Não abriu terminal: o app mostra o comando pra colar no seu terminal.
- Assinatura no limite: o agente para com a mensagem do limite; use o modelo reserva ou espere a janela zerar (veja **limites**).
