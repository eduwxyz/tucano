# Motores e contas
> Onde os agentes rodam: um endpoint próprio, os harnesses, como entrar, contas extras, gateway da empresa e o roteador Jev.

Os agentes não têm modelo próprio: cada resposta roda num endpoint seu ou num programa que você já tem no computador, chamado harness.

## Endpoint próprio
Sem instalar nada: em **Configurações › Modelos**, **Endpoint próprio** › **Configurar**. Cole o endereço no padrão da OpenAI (OpenRouter, OmniRoute, Ollama, LM Studio, vLLM; os atalhos preenchem) e a chave, **Buscar os modelos**, marque os que os agentes podem usar e **Salvar**. A chave fica guardada cifrada no Tucano. O modelo precisa saber chamar ferramentas. Com **Web** ligada, o agente busca na web (pela Exa) e lê páginas com as ferramentas do Tucano. Cobra por token, no endpoint.

## Os harnesses
Claude Code, Codex, OpenCode, Pi, Antigravity CLI, Cursor CLI, Grok, Cline CLI e Hermes. Cada um aparece em **Configurações › Modelos** (Settings › Models), no card **Harnesses**, com o estado: **Pronto**, **Falta entrar** ou **Não instalado**.

- **Instalar**: abre um terminal que instala pra você. Alguns precisam do Node.js antes.
- **Entrar**: abre um terminal com o comando de login (por exemplo `claude auth login`, `codex login`, `grok login`). Quando o login termina, o app percebe sozinho.
- **Testar** / **Mandar teste**: confere se está funcionando.
- **Verificar de novo**: procura de novo depois de instalar ou entrar.

O **Cline CLI** entra num login só do Tucano (**Entrar** abre o `cline auth`); o seu `~/.cline` não é tocado, e o agente só usa as ferramentas do Tucano. Outro modelo vai em **Outro modelo…** como `<provedor>/<modelo>`. Imagens não vão pro Cline.

Dos harnesses, o Tucano só lê a configuração; nunca vê nem guarda suas senhas e chaves. Cada um pode rodar de três jeitos, conforme você configurou: no **plano** (o login do Claude, do ChatGPT etc., sem cobrança por uso), por **chave de API** (cobrado por token) ou pelo **gateway** da empresa (o proxy que está no `settings.json` do Claude Code ou no `config.toml` do Codex). Pelo gateway, os agentes usam o mesmo e a telemetria fica desligada.

## Modelo de cada agente
Na página do agente, em **Onde roda e modelo**, você escolhe o motor e o modelo da lista dele. Se o modelo não aparece, use **Outro modelo…** e digite o nome exato. Dá pra ter um **Modelo reserva**, usado quando o principal bate no limite da assinatura.

## Contas extras
Pro Claude Code e o Codex dá pra ter mais de um login (ex.: "Trabalho"). Em **Configurações › Modelos** › **Contas**, **Adicionar e entrar**. Cada agente escolhe a conta em **Conta**. Uma conta que ainda não entrou deixa o agente sem responder até você entrar nela. Em **Como usar as contas** dá pra **Equilibrar entre as contas** (veja **limites**).

## O roteador
Em **Configurações › Modelos** › **Roteador** (Router), o modelo pequeno que lê a conversa e decide quem responde nos canais. Prefira um rápido. Uma opção é o Jev, da TypeSafe: decide em menos de 1 segundo, mas manda as últimas 10 mensagens do canal pra TypeSafe e precisa da **Chave do TypeSafe**. Se ele falhar, o Haiku decide.

## Quando dá errado
- Agente não responde e o harness diz **Falta entrar**: clique em **Entrar** e faça o login no terminal.
- Não abriu terminal: o app mostra o comando pra colar no seu terminal.
- Assinatura no limite: o agente para com a mensagem do limite; use o modelo reserva ou espere a janela zerar (veja **limites**).
