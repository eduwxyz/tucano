# Changelog

What changed in each version of Tucano. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org) (while in 0.x, a minor version may change things). Each section is also the release's notes on GitHub, which is what the app's "What's new" link opens.

## [Unreleased]

> **Em português:**
> - **Avisos no iPhone com o app fechado.** Aprovações, perguntas e respostas prontas chegam como notificação mesmo com o app fechado, e tocar abre a conversa.
> - **Entrar na IA pelo navegador ou pelo iPhone, num Tucano em servidor.** O botão Entrar roda o login da própria IA no servidor e mostra a tela dele numa janela: a página pra abrir, o código pra digitar e um campo pra colar o código de volta. Sem SSH.
>
> **Correções:** um agente com o GitHub em **Ler e escrever** volta a subir a branch e abrir a PR em vez de dizer que "a sessão é só leitura" (e, se algo pede aprovação ou está desligado, diz exatamente o quê); e o cartão **Computador** mostra o que vale pra cada escolha, sem misturar a confirmação de **Este computador** com o painel do Linux; e o QR code de Configurações › Celular › Seu iPhone traz o endereço do computador na rede de casa, que o iPhone alcança (antes, o nome .local fazia a conexão falhar).

### Added

- **Sign a harness in on a server from the browser or the phone, with no SSH.** On Tucano as a server, **Sign in** (Settings › Models and the accounts) used to show a command to run in the server's terminal. Now the server runs the harness's own login in a terminal of its own (through `script`, on Linux) and the browser shows it in a window: the screen as text, **Open the sign-in page**, the code to type there with a copy button, a field to paste a code back, and arrows, Enter and Esc for a menu. Each harness signs in the way that works with no browser on the server: Codex and Grok with a device code, Claude Code by pasting the code its page shows, Cursor by approving its page, OpenCode and Gemini in their own menus, Pi with `/login`. The window closes the login once the harness checks as signed in, and a login left open ends after 15 minutes. Tucano passes keys and shows the screen; the harness saves the login where it always does. The iPhone app shows the same window (in its next version). On a desktop, **Sign in** opens a terminal as before.
- **Notifications on the iPhone with the app closed.** Approvals, questions and finished replies used to reach the Tucano app only while it was open. Now a phone that allows notifications gives its Tucano (a server, or the computer at home) a handle, and the Tucano asks a relay at tucano.sh to deliver through Apple. The handle is the phone's Apple token sealed by the relay, which alone holds the app's push key: a Tucano can reach only the phones that connected to it, and a disconnected device stops getting them. The relay passes on the title and the line, as the desktop's notification shows them, and stores nothing. `TUCANO_PUSH_URL` points at another relay, or `off`. Tapping a notification opens its conversation, on the right Tucano (in the next version of the app).

### Fixed

- **The iPhone connects to the computer's Tucano on a real home network.** The QR code in Settings › Phone › Your iPhone named the Mac by its Bonjour name (`name.local`), which the iPhone app couldn't reach on a real Wi-Fi: it waited and gave up with "Couldn't reach your Tucano", while the same QR code with the address connected. It now carries the computer's address on the home network, read each time a QR code is made, as on Windows and Linux.
- **An agent with GitHub on "Ler e escrever" pushes and opens the PR instead of saying the session is read-only.** On Codex, the CLI's own text about its sandbox ("`sandbox_mode` is `read-only`... Network access is restricted", "Approval policy is never") reached the model, and it answered "Estou bloqueado porque esta sessão permite apenas leitura" for a push or a PR it had every grant for. That text is left out now (in `codex exec` and the app-server), and the note an agent with the app's tools gets says Codex's sandbox doesn't limit them, that git and other commands on its computer run with `bash`, and to say exactly what was refused or waits for approval, never "read-only". On every harness, an agent with a GitHub connector gets a **GitHub** section in its instructions, made from what it really has: the tools it publishes with (`create_branch`, `push_files`, `create_or_update_file`, `create_pull_request`, by the names it sees); on **Este computador**, that `git push` also runs with your own git credentials; on **Linux isolado**, that there are none there; what your autonomy level or rules make ask first or turn off; and, with read-only access, to ask for read and write with `pedir_acesso`. Before, an agent on this computer was told only "git push only when asked", with no word about the connector.
- **The agent page's Computador card shows what each choice means, from the first look.** Clicking **Este computador** after **Linux isolado** showed the confirmation on top of the Linux panel (the Docker state, **Pastas do seu computador**, **Apagar computador**), with Linux still picked and already saved, and that mix read as this computer's full card, while the real one looked cut short. Now the confirmation shows alone, with **Este computador** picked, and **Cancelar** (or clicking the saved choice) goes back to it; once allowed, the card says the commands run on your computer as you, starting in its folder, and that it reaches your folders without lending them and needs no Docker.

## [0.2.18] - 2026-11-07

> **Em português:**
> - **Uma introdução que qualquer pessoa segue, e que leva 3 cliques quando tudo já está pronto.** O Tucano acha o Claude Code, o Codex e os outros que você já usa e testa cada um. Se não tiver nenhum, ele baixa o Codex ou o Claude Code oficial e abre o login no navegador, sem terminal. O Tuca pergunta o que você quer tirar das costas, monta o agente e explica o que ele faz em português de gente. Depois, balões mostram o app de verdade, e os Primeiros passos viram **Missões**.
> - **Quanto cada agente faz por conta própria.** Em Configurações › Agentes › Autonomia, e na página de cada agente: **Cuidadoso** pede antes de qualquer mudança, **Normal** é como sempre foi, **Sem travas** envia, apaga e paga sem perguntar (com confirmação). Dá pra ajustar ação por ação, e a introdução já pergunta isso.
> - **Proteção contra texto que manda no agente.** Depois de ler algo de fora (um email, uma página, uma issue), enviar, publicar, pagar e apagar pedem antes, mesmo onde rodariam sozinhos.
> - **Seu iPhone no Tucano do computador,** pelo Wi-Fi de casa: Configurações › Celular › Seu iPhone mostra um QR code.
> - **As decisões de um agente, uma por vez, com opções pra escolher,** num cartão embaixo da resposta.
> - **O cartão de perfil do agente,** ao clicar no rosto ou no nome.
>
> **Correções:** um programa que falha diz o motivo numa linha, sem erro técnico na tela; o link de conexão de um servidor só conta quando você clica em Entrar (a prévia de link do Discord ou do WhatsApp gastava o código); e os aparelhos conectados aparecem numa lista, com Desconectar.

### Added

- **A first run anyone can follow, and that takes three clicks when everything's ready.** The introduction was nine steps (where agents run, the models, you, tools, skills, the agent, its powers, the first task) and told people to sign in "in the terminal that opened". Now it's one guided path in the look of the phone app: your name; the AI; the Tuca asking **"Qual é a primeira coisa que você queria tirar das suas costas?"**; the agent. If Claude Code, Codex or another one is already signed in, it shows up tested with a real reply (and how long it took), with switches to bring the tools and skills it found along (**ver quais** names them), and the two small models behind the scenes picked on their own (**Trocar** shows them as two cards, who replies and the memory, each opening one menu with every ready harness's models). If nothing is, **ChatGPT** or **Claude** sets it up with no terminal (below), and **Não assino nenhuma** explains which plan to get, with the official links; **Uso chave de API, gateway da empresa ou outro programa** opens the harnesses as before. The Tuca offers six goals (organize my week, research and summarize, write emails and posts, reply to customers, handle spreadsheets, code) or takes your own words, dictation included, and the agent is born from a built-in template at once, no wait on a model: its face, a name you can change, a color, what it does in plain words, and **"Quanto {nome} faz por conta própria?"**: **Me pergunta antes de mudar qualquer coisa** (Careful), **Faz o dia a dia por conta própria e pergunta antes do que importa** (Normal, recommended and picked) or **Faz tudo por conta própria, até enviar e pagar** (No guardrails, after the same confirmation as Settings), with a line under it saying what still asks. The answer is the agent's own autonomy level (Normal stays on Default, following Settings); the rules by kind and the outside-content guard stay on the agent's page. The detailed form asks the same, and **Ajustar com o Tuca** keeps the answer. It starts safe: no computer, connectors read-only, the web only where the goal needs it; a connector that fits the goal and signs in with one click in the browser is offered as optional (Todoist for the week, Notion for writing, Linear for code; none for the others, and nothing that needs an app, a token or an address of your own). **Ajustar com o Tuca** talks it over with him and brings his card back; **Prefiro configurar do zero** opens the detailed form. **Chamar … pro time** lands in #geral with the first message written and not sent, and a balloon over the field says to press send.
- **Codex and Claude Code set up from the app, with no terminal.** Picking ChatGPT or Claude in the introduction downloads the official CLI from where its own installer gets it (Codex's release package on GitHub, Claude Code's from downloads.claude.ai), checks it against the published sha256 and keeps it in the app's data folder (on the PATH after any the person installed), then starts the CLI's own sign-in (`codex login`, `claude auth login`), which opens the browser and finishes on its own callback on this computer. Tucano never sees the password or the tokens, and never relays a code; the binary isn't changed. The screen shows the steps (setting up, signing in, a real test reply), with **Abrir de novo** for the sign-in page and, if something fails, **Tentar de novo** or **Fazer pelo terminal**. macOS, Windows (x64 and arm64) and Linux (x64 and arm64, glibc or musl); on a server the sign-in stays in its terminal.
- **The tour, done instead of read.** Balloons over the real screens, once each: the first message; the first time an agent really asks you something (an approval, its questions, a proposal; nothing is staged, so it waits for one), **"Quando {nome} precisar de você, pede aqui"**, with what asks at the agent's level and never a promise that everything does; then the Tuca, for help; then the missions. The screen stays usable under them, Esc or **Entendi** closes one and **Pular tour** ends them.
- **A short welcome for someone invited to a team**, in the browser or the app: who invited them, the team's agents, their name and an optional "what you do", and the deal (direct messages with an agent are theirs alone, not even the owner's; channels are seen by everyone; agents ask whoever decides before what the team agreed on). Then the short tour. Only people who join from now on see it.
- **An agent's profile card, from its face or name.** A click on an agent's face or name (on its message, in a thread, an `@mention`, the faces at the top of a channel, the top of its DM) opens a small card next to it, as Slack does; resting the mouse there for half a second opens it too, and it goes when the mouse leaves. The card shows its picture, name, `@handle` and role; what it's doing now (working, and on which step, with a link to the conversation; waiting for an answer or an approval, and whose, when there's a team; at its monthly limit; archived; or when it last spoke); its model and harness; its computer; the channels it's in; and buttons to message it or open its full page. The faces at the top of a channel and the name at the top of a DM open the card instead of the agent's page, and the DM's **See profile** button is now a gear for the conversation's settings. People's faces stay as they were. Esc gives the focus back to what opened it. Thanks [@rjgdias](https://github.com/rjgdias)! ([#134](https://github.com/eduwxyz/tucano/pull/134))
- **An agent's decisions, answered one at a time with options to pick.** `ask_user` took a single string, so agents packed their findings, a proposal and several questions into one unformatted card. Now an agent asks for 1 to 4 decisions, each a single choice, a multiple choice or a short text, and writes its analysis in the reply, which renders as usual; a question over 200 characters goes back to the agent asking for the context in the reply. The decisions come as a card under the agent's reply, one at a time (with arrows and "1 of 2"): the agent suggests 1 to 3 options and the card always adds "Something else", which opens a field for your own answer. Pick with a click or the option's number, Enter confirms, "Skip" moves on, and with more than one decision there's a review before sending, where any answer can still change. The answer goes as your message, one line per decision. The message box below stays as it was: writing there answers too, and what you already picked on the card goes along. Once answered, the card keeps each decision with what was chosen, and the sidebar marks a channel or DM where an agent waits on you, with who in its tooltip. With a team, a question to someone carries its decisions too: the asked person (or whoever covers for them) answers them on the card, in the conversation or in **For you**; an admin can answer for them; everyone else sees what was asked and, afterwards, who answered. A question from a DM still waits for the DM's person's yes first, and the sidebar marks only what waits on you. Older pending questions still work, and Telegram gets the decisions as numbered text, answered by replying. Thanks [@cleitoncsalvagni](https://github.com/cleitoncsalvagni)! ([#145](https://github.com/eduwxyz/tucano/pull/145))
- **How far each agent goes on its own.** **Settings › Agents › Autonomy** sets a level for every agent, and each agent's page (Tools) can set its own: **Careful** asks before anything that changes something (a write in a connector, a commit, a push, a risky click); **Normal** is how Tucano always worked, reading and writing on its own and asking before what's sensitive; **No guardrails** sends, deletes, publishes, pays and clicks without asking, after a confirmation. Under **Fine-tune action by action**, each kind (commit, push, pull request, merge, delete, send, publish, pay, a risky click in the agent's browser, a risky action in an app) can ask first, run alone or never happen, over the level; an agent's own rule wins over its level, which wins over Settings. A tool you marked high risk always asks, and a step that ran without asking says so ("Ran (no ask: autonomy)"). Commands on the agent's computer are read before they run, every command on the line (from #110, by @rjgdias): a commit, a push or an `rm -r` that a rule holds becomes an approval with the exact command, and approved, exactly that runs.
- **A guard against text that tells the agent what to do.** An email, a page or an issue can carry instructions someone else wrote. After an agent reads something from outside in a reply (a connector's answer, a page, an app, the web, a trigger's event), sending, publishing, paying, deleting and risky clicks ask first, even where a rule or the level lets them run, and the card says why. It's on by default, in Settings and on each agent's page; an agent's next replies in the same conversation keep it, since its session still holds what it read.
- **Your iPhone, on your computer's Tucano.** **Settings › Phone › Your iPhone › Connect my iPhone** shows a QR code: the Tucano app for iPhone reads it and gets in as you, with your conversations, approvals and the agents' questions, over the home Wi-Fi while the computer is on. No team or server needed. The computer answers only devices on its own network, over HTTPS with a certificate of its own whose fingerprint rides in the QR code, so another device on the Wi-Fi can't pose as it; each phone gets a key of its own from a one-time code. It stays on across restarts until **Turn off**. On a Mac the phone finds the computer by its Bonjour name; on Windows and Linux, by its address on the home network. Away from home the phone can't reach the computer: that's what a server or Tucano Pro is for.

### Fixed

- **A harness that fails says why in one line, not a stack trace.** When Claude Code, Codex, Pi or another one fails its test (in the introduction or in **Settings › Modelos › Testar**), the row says what happened and what to do: an expired or invalid login names the harness and, for Pi and OpenCode, the provider ("O login da Anthropic no Pi expirou. Entre de novo no Pi pra usar."), with **Entrar de novo** and **Tentar de novo**; a limit or a timeout gets its own line; anything else a short line, with the raw text under **Ver detalhes** in a small scrolling box. In the introduction a harness that failed is muted and doesn't hold up the others: the button reads **Continuar com Claude Code**. The harnesses show their own marks instead of a letter (Grok keeps its initial).
- **A server's one-time link signs in the browser that opens it, not whatever opened it first.** Opening the link from **Settings › People › Connect a phone** (or `server.js pair`) spent the code at once. A chat's link preview (Discord, WhatsApp, iMessage, Slack), a browser's prefetch or prerender of a pasted address, or a mail scanner got there first: each became a device no one holds, the person's own visit read "this link was already used or has expired", and "You're signed in on N devices" went up by one every time. Now the link opens a page that says whose Tucano it is and as whom, with a **Sign in on this browser** button; only that button (a POST from the same page) spends the code, once. A prefetch gets nothing, and a wrong or used code still counts as a guess, as before. The phone's QR code and link, the desktop app's pairing and invites (`/?invite=`, which never spent anything on opening) work as they did.
- **Your devices can be seen and disconnected.** Under "You're signed in on N devices", **Settings › People** lists each browser and phone signed in as you, when it was added, when it was last seen (or "never used", like the ones a link preview made), and a **Disconnect** button. Disconnecting signs that device out at once and closes its open pages; the others stay. The one you're using is marked, and asks before going. On the desktop app, **Settings › Phone › Your iPhone** lists the iPhones paired over the home Wi-Fi the same way, and **Disconnect** cuts that phone off right away, open connection included.

### Changed

- **"Primeiros passos" is now Missões**, a card at the bottom of the sidebar and a page of its own, still checking itself off as things happen: talk to your agent, approve something, connect an account, build a second agent, put something on autopilot, keep something that matters. On a new install the sidebar starts short (the Tuca, what waits for you, the channel, the agent, the missions and the settings) and each mission brings a part of it, tagged **NOVO** until opened: Connectors, Channels, Routines, Memory and Wiki; a part with something in it shows anyway, and **Mostrar tudo de uma vez** shows the whole sidebar. An existing install keeps its sidebar as it was and never goes through the new introduction; **Configurações › Geral › Rever a introdução** still shows it.

## [0.2.17] - 2026-11-07

> **Em português:**
> - **Composio na loja de conectores.** Centenas de apps (Google, Notion, HubSpot…) sem configurar nada: entra pelo navegador. Os dados passam pelos servidores da Composio, e o cartão diz isso com clareza. Cada ação conta pelo que faz: ler roda na hora, escrever pede acesso de escrita, e enviar pede aprovação.
> - **Enviar algo pra outras pessoas pede antes, por padrão.** Postar, responder, encaminhar, compartilhar, convidar, comentar ou mandar email agora é sensível, como enviar e apagar já eram. Pra deixar um agente postar sem perguntar, use "Aprovar e sempre permitir". Uma classe que você mudou à mão fica.
> - **Respostas encadeadas entre agentes viram configuração.** Em Configurações › Agentes › Limites, de 1 a 10 (continua 3 se você não mexer).
> - **Listas de escolha com a cara do app,** com filtro na lista de modelos e modelos agrupados por provedor.
> - **Receitas de skill longas ficam inteiras:** 10 mil caracteres vira uma recomendação, não um limite.
>
> **Correções:** a wiki não perde mais uma resposta longa que terminou depois de outra; os conectores do Google explicam o passo do Developer Preview que faltava.

### Added

- **How many replies agents give in a row is a setting.** Agents mentioning each other stopped after 3 replies from one message, which cut flows like planner → developer → reviewer → developer halfway. **Settings › Agents › Limits** now has **Agent replies in a row**, from 1 to 10; left alone, it stays 3.
- **Composio in the connector store, with a warning.** [Composio Connect](https://docs.composio.dev/docs/composio-connect) reaches hundreds of apps (Google, Notion, HubSpot…) with nothing to set up: no Google Cloud app, no token; it signs in through the browser. Unlike every other connector, the data goes through Composio's servers and the access to each account is kept by Composio, which logs each call; the card, the window before connecting and the connector's page say so plainly, and point to the direct connectors. Composio offers a few tools that find and run the apps' actions instead of one tool per action, so each call to one of its runners counts as what it runs: a batch in `COMPOSIO_MULTI_EXECUTE_TOOL` takes the strictest of its actions, judged by their names (`GMAIL_FETCH_EMAILS` reads, `GMAIL_CREATE_EMAIL_DRAFT` writes, `GMAIL_SEND_EMAIL` is sensitive), and a raw `COMPOSIO_PROXY_EXECUTE` request by its method. Reads alone run right away, even with read-only access; writes need read-and-write access; sensitive actions ask for approval, and the card lists each action. A call outside Composio's documented shape, an action it can't place, or its remote code tools always ask. "Approve and always allow" on a batch allows each inner action that asked (say, `GMAIL_REPLY_TO_THREAD`) for that agent, never the runner itself: a later batch runs without asking only when every action that would ask is allowed. Raw requests, code and calls outside the shape are never allowed for good, and the rules show and can be removed on the agent's page like any other. Google's setup window mentions it as the way around making a Google Cloud app.

### Changed

- **Long skill recipes are kept whole.** A recipe over 20,000 characters was refused when written or proposed, cut when linked from Claude Code or Codex, and left out of an imported team. Now 10,000 characters is a recommendation: past it, Tucano says by how much and keeps the whole recipe, up to a million characters.
- **The pick lists look like the rest of the app.** Effort, model, a tool's class, the routine's agent and where it posts, and the other settings pick lists open a menu of the app's own instead of the system's, with the keyboard working as before. The model list has a filter, and on a harness with models from several providers (OpenCode, Pi), they come grouped by provider.
- **Sending something to other people asks first, by default.** A connector tool whose verb puts something in front of others (post, reply, forward, share, invite, comment, email, message), or that creates a comment, a reply or a post, is now sensitive, like send and delete already were: Slack's post-message, Linear's `save_comment`, GitHub's `add_issue_comment`, Notion's comment tool. The words count only as the verb, so `list_messages`, `get_message` and `search_emails` still read, and a draft (`create_email_draft`) is still a write. To have an agent post without asking, use "Approve and always allow" on its request, or set the tool's class to "write" on the connector's page. A class you chose by hand now stays when the tools are refreshed and when the rules change: on the first connection after updating, a tool whose class was still the automatic one takes the new default, and one you changed keeps yours.

### Fixed

- **The wiki no longer misses a long reply.** A reply that started before another and ended well after it never reached the wiki, because the wiki's curator had already read past where it started. It now goes by when each reply ended, the same order the conversation shows.
- **Google's connectors say what their preview needs.** Google's MCP servers are in Developer Preview and only serve Cloud projects enrolled in the [Google Workspace Developer Preview Program](https://developers.google.com/workspace/preview), which the setup didn't say: the connectors failed with "Access to this tool requires that your Google Cloud project (…) is enrolled in the Google Workspace Developer Preview Program". The Google setup window and the guide now have that step (the form asks for the project number; approval usually takes a couple of days), and when a Google tool still answers with that error, the agent is told it's a step only the person can do in their own Cloud project, not something to retry or ask the Tuca for, and that Composio connects Google meanwhile, through its servers.

## [0.2.16] - 2026-11-07

> **Em português:**
> - **O celular entra como você.** Num Tucano em servidor, Configurações › Pessoas › Conectar um celular mostra um QR code que vale uma vez, por 10 minutos: o app do Tucano pro iPhone (chegando na App Store) lê o código e entra como você, com suas DMs, aprovações e perguntas. No servidor, `npm run server -- pair` gera um pro dono. Um link de convite também funciona no app: ele pede o nome e a pessoa entra.
> - **Sair de um Tucano por conta própria.** Quem foi convidado pode sair pelo app: o acesso acaba na hora, em todos os aparelhos, e as DMs, memórias e rotinas da pessoa são apagadas. O que ela disse nos canais fica com o time.

### Added

- **Phones sign in to a Tucano on a server, as their person.** **Settings › People › Connect a phone** shows a QR code that's good once, for 10 minutes: the Tucano app for iPhone (coming to the App Store) reads it and gets a key of its own, signed in as whoever made the code, with their DMs, approvals and questions. On the server, `npm run server -- pair [minutes]` makes one for the owner (the same link opens a browser too, with `/?code=`). An invite link also works in the app: it asks the name and the person is in.
- **Leaving a Tucano on your own.** Someone invited (not the owner) can leave from the iPhone app: their access ends at once on every device, and their direct messages, memories and own routines are deleted right away instead of after 30 days. What they said in channels stays the channel's, and the agents they made go to the owner.

## [0.2.15] - 2026-11-07

> **Em português:**
> - **Respostas mais rápidas no Claude Code.** As ferramentas dos conectores ficam atrás da busca de ferramentas, em vez de irem todas em cada chamada: um agente com 198 ferramentas mandava 239 mil tokens por chamada e agora manda 11 mil, cerca de 7% do que ia antes. As que o agente usou nos últimos 14 dias já vêm carregadas. Uma memória nova, uma página na wiki ou uma rotina não reiniciam mais a conversa do agente. Suas mensagens passam na frente de rotinas e repasses.
> - **O Codex escreve na hora.** O texto aparece enquanto é escrito, e uma conversa continua do ponto em que estava, sem reenviar tudo.
> - **O app abre em menos de 1 segundo** (eram 4 a 9) e não trava mais enquanto a resposta chega, nem com conversas longas.
> - **Times: várias pessoas no mesmo Tucano.** Num Tucano em servidor, Configurações › Pessoas convida alguém por link. Cada pessoa tem suas DMs com os agentes (privadas, nem o dono lê), sua memória e o que espera por ela em **Pra você**.
> - **Mofi na loja de conectores:** contas, cartões, faturas e gastos dos seus bancos, pelo Open Finance, sem movimentar dinheiro.
> - **O GitHub passa pelo conector.** Os agentes publicam no GitHub (branch, arquivos, PR) com as ferramentas do conector do GitHub; o push pelo computador do agente saiu.
>
> **Correções:** um pedido a alguém no fim de uma resposta longa chega a essa pessoa; as respostas aparecem na ordem em que terminaram; o Chrome de um agente tem 30 s pra abrir; o botão da nota de atualização fica embaixo do texto.

### Added

- **Mofi in the connector store.** Your bank accounts, cards, invoices and spending from Brazilian banks (through Open Finance), from [Mofi](https://omofi.com.br/docs/mcp)'s official server. It signs in through the browser, and its tools only read: none moves money; the most they do is set a transaction's category or ask the banks for an update.
- **Teams: several people on the same Tucano.** On a Tucano on a server, **Settings › People** invites someone with a one-time link (good for 7 days), as owner, admin or member. Each person has their own name, their own direct messages with the agents (private, even from the owner), their own memory, display preferences and unread counts; every message and approval carries who wrote, asked and decided it. An agent's approvals go to its owner (or admins), and **For you** gathers what waits on each person. A `@name` calls a person; an agent can ask a specific person and wait for that one task, with a deadline and someone covering for whoever is away. Routines are "just for me" or the channel's. **Activity** shows the owner and admins who joined, left, approved and changed what, never what was said in a DM. Removing someone ends their access at once and keeps their private things 30 days before they're deleted. On the first invite, channel summaries are rebuilt without anything from the owner's DMs, older channel messages and wiki history stay the owner's, and wiki pages that came from the owner's DMs wait for the owner to release them. A Tucano used by one person, on the desktop, works exactly as before.

### Changed

- **Faster replies on Claude Code.** Connector tools now wait behind the CLI's tool search instead of going into every model call: for one agent with 198 tools, a call went from 239k input tokens to 11k, and on 30 scenarios a reply sends 6–7% of what it did, with the same answers. The app's own tools stay loaded, and so do the connector tools the agent used in the last 14 days (up to 12), so a familiar tool doesn't cost a search. Memories, the wiki, skills, routines and disconnected connectors moved out of the system prompt, so a change to them no longer starts every agent's session over: a kept session gets them again only when they changed. Multi-step tasks and conversations got about 20–25% faster; turns after the first in a 6-turn conversation took 3.8 s instead of 5.9 s.
- **Your replies go first.** A message, an approval, a retry or a browser handed back goes ahead of routines, hand-offs and follow-ups, and may run past the usual 4 at once, up to 6. Up to 4 Claude Code processes stay ready 10 minutes after a reply (was 2 for 5), typing in a channel readies whoever answered last there, and opening a conversation readies its session.
- **Codex streams as it writes.** Agents on Codex run on one long-lived `codex app-server` per login: threads are kept and resumed, so only what's new is sent, and the text shows as it's written (the second turn's first text came in 1.0 s, was 2.4 s). Every isolation setting stays as it was; an older Codex, a Codex home with its own `config.toml` or rules, or `TUCANO_CODEX_EXEC=1` still use `codex exec`.
- **The app opens sooner and stays light.** The core is ready in under a second (was 4.5–9.4 s); finding the CLIs happens after, and what was found is kept for the next launch. Installed apps are rescanned at most once a day, a big Obsidian vault is indexed without blocking, and the workspace on screen starts first. While a reply streams, only its own message redraws. A conversation opens with its last 100 messages, and older ones load as you scroll back.
- **GitHub goes through its connector.** Agents publish to GitHub (a branch, files, a pull request) with the GitHub connector's tools, with the permissions and approvals of any connector. Pushing from the agent's computer and the `abrir_pr` tool are gone, and Settings' "Phone and GitHub" tab is just **Phone**. A computer that pushed through Tucano's proxy before gets its git settings put back when it starts.

### Fixed

- **An agent's Chrome gets more time to open.** The first open on a slow computer could pass the 15 s it had, and the agent got an error instead of the page. It now gets 30 s.
- **Replies show in the order they ended.** With several agents answering at once, a reply that took longer stayed above one that was already done. Now it takes its place when it ends, with that time on it, and whoever is still working stays at the end of the conversation. Agents still read each other in the order they started, so what each one saw doesn't change.
- **An ask at the end of a long reply reaches its person.** The hand-off check read only the first 3,000 characters of a reply, so a `@name` asked at the end of a long plan was missed. It now reads the start and the lines around each mention.
- **The update note's button goes under its text.** With an agent working, a long "Restart anyway" squeezed the note's text into a narrow column.

## [0.2.14] - 2026-11-06

> **Em português:**
> - **Google e Slack nos conectores.** Gmail, Calendar, Drive, Docs e Sheets, pelos servidores oficiais do Google, e o Slack, pelo dele. Os dois só aceitam apps cadastrados neles, então o primeiro Conectar mostra como criar o seu, uma vez: 5 passos no Google, 2 no Slack (o link já traz tudo preenchido). Depois, é um clique.
> - **Mais seis conectores, e segredos no 1Password.** GitHub, Dynatrace, Snowflake, Metabase, Azure DevOps e AWS CloudWatch: a loja pede o endereço ou o token numa janela. No lugar de um token, dá pra pôr uma referência do 1Password (op://…), lida a cada conexão.
> - **O Tucano num servidor, pronto pra outras pessoas.** Entrar por link, as páginas que os agentes servem abrindo pelo servidor, arquivos que sobem e descem, o login dos conectores terminando sozinho e as notificações no navegador.
> - **O app abre os seus Tucanos em servidores.** Um link tucano://connect pareia o app com um Tucano num servidor, que aparece na mesma janela, com uma barra pra voltar; ficam em Configurações › Servidores.
>
> **Correção:** um agente no Codex volta a salvar arquivos no computador dele, em vez de dizer que a sessão é só leitura. Acontecia quando um agente caía no modelo reserva do Codex.

### Added

- **Tucano as a server, ready for other people to use.** Sign in by a link (`server.js link` prints it; `TUCANO_URL` behind a proxy), and twenty wrong tokens from one address lock it out for ten minutes. Pages agents serve open at `https://<port>-<address>`, through the server, with a sign-in of their own, WebSockets included. A file sent with a message goes up to the server, a cited one comes down, an Obsidian vault comes in as a .zip, and folders are picked on the server. OAuth connectors finish on the server's own address, with nothing to paste; notifications reach the browser, and a connection that goes quiet comes back with the drafts kept. An idle agent's Chrome closes after ten minutes and reopens on the same page.
- **The desktop app opens your Tucanos on servers.** A `tucano://connect` link (`server.js link` prints it, next to the browser's) pairs the app with a Tucano on a server: its page shows over the app in the same window, in a view with no bridge to this computer, under a bar to go back, signed in with a token the system's keychain keeps. **Settings › Servers** lists them, pairs a pasted link and forgets one; the workspace list, the Window menu and the tray open them, and the server on screen when the app quit comes back at launch.
- **Six more connectors in the store, for services that ask a few things first:** GitHub (a personal access token), Dynatrace and Snowflake (your instance and a token), Metabase (your address, then the browser sign-in), and Azure DevOps and AWS CloudWatch, which run the service's official server on this computer (with npx and uv). The store asks for what each needs in a window and adds the connector as the custom form would.
- **A connector's secrets can stay in 1Password.** In place of a token or a variable of a local connector's command, an `op://Vault/Item/field` reference: Tucano keeps only the reference and reads the value with the 1Password CLI on each connection, and says what to do when the CLI is missing, signed out or locked, or the item isn't there.
- **Gmail, Google Calendar, Google Drive, Google Docs and Google Sheets in the connector store**, through Google's own MCP servers. Google signs in only apps registered with it, so the first one walks you through making yours in Google Cloud, once, in five steps with a link for each; the other four then sign in with one click. Each asks only for what its tools need: Gmail searches, reads, drafts and labels but never sends nor deletes for good, and Drive writes only the files it made or opened. The Tuca's guide explains the steps and what to check when Google turns a sign-in away.
- **Slack in the connector store**, through Slack's own MCP server. Slack takes only directory apps or a workspace's internal apps, so the first Connect makes yours from a link that fills it all in (permissions, MCP on, the address to come back to): pick the workspace, create, paste its Client ID and Secret. Agents act as you, with a user token, through the same classes and approvals. The sign-in comes back through the workspace's fixed webhook port, since Slack takes only the address registered in the app. Google's or Slack's app can be changed from the connector's page.

### Fixed

- **An agent on Codex writes files on its computer again, instead of saying the session is read-only.** Codex runs in a read-only, empty sandbox on purpose, and tells the model so; newer models (GPT-6-Astra) took that for the agent's computer and answered "this session has read-only filesystem access" without trying `write_file`, or tried Codex's own `apply_patch` and gave up. It showed when an agent fell back to a Codex reserve model. An agent with a computer is now told that sandbox isn't its computer. Agents also no longer send you to the Tuca to get access back: he can't change it.


## [0.2.13] - 2026-11-06

> **Em português:**
> - **Segurança: duas correções.** Um link na resposta de um agente não abre mais um arquivo local como se fosse o app ([GHSA-6pvc-g4mm-34rq](https://github.com/eduwxyz/tucano/security/advisories/GHSA-6pvc-g4mm-34rq)), e Enter, Espaço ou um clique num botão sem nome no navegador de um agente não passam mais sem a sua aprovação quando publicam, enviam ou apagam ([GHSA-4q39-94jc-xhq8](https://github.com/eduwxyz/tucano/security/advisories/GHSA-4q39-94jc-xhq8)). Atualize.
> - **Qualquer agente cria por você.** Peça a um agente um agente novo, um time de agentes com um canal, uma rotina, um canal ou uma mudança num agente, e ele propõe num card com Aplicar e Descartar: nada muda até você aplicar.
> - **O Tuca te ajuda com o Tucano.** Ele faz o que dá em vez de ensinar o passo a passo, explica o resto lendo um guia do app, e descobre por que algo não está dando certo olhando o workspace: motores, conectores, limites, rotinas e os erros das respostas, nunca o que foi dito nas conversas. Quando cita uma tela, manda um botão que leva até ela.

### Security

- **A link in an agent's reply can't open a local file as the app anymore.** The window only ever shows the app, only the app's own page talks to its main process, and message links keep only http, https and mailto ([GHSA-6pvc-g4mm-34rq](https://github.com/eduwxyz/tucano/security/advisories/GHSA-6pvc-g4mm-34rq)). Thanks to @rayanneblima.
- **Enter, Space or a click on a nameless button in an agent's browser ask for your approval** when they publish, send or delete, as a click on a risky button did; clicks are judged by the page's own words, not the agent's ([GHSA-4q39-94jc-xhq8](https://github.com/eduwxyz/tucano/security/advisories/GHSA-4q39-94jc-xhq8)). Thanks to @marcossimo.

### Added

- **Any agent makes things for you, as cards you apply.** Ask an agent for a new agent, a team, a routine, a channel or a change to an agent, and it proposes it: a new agent as before; a team of 2 to 8 agents with a channel for them, created at once with **Create team**; a scheduled routine for any agent (an agent's own still go through scheduling it itself); a channel with its agents; or a change to an agent that exists, shown as before and after. Each is a card with **Apply** and **Discard**, applied the way the screens do it, and nothing changes until you apply it. Agents are told to propose when you ask or when it clearly solves what you asked, not in the middle of other work.
- **The Tuca helps you with Tucano.** He does what he can instead of explaining how, asking only for what's missing, even when you ask "how do I…?". The rest he explains from a guide of the app (17 pages, from agents and connectors to workspaces and troubleshooting) he reads before answering, so he doesn't make up screens; other agents send those questions to him. Asked why something isn't working, he looks at the workspace first: harnesses and sign-ins, connectors and their errors, each agent's model, access and limit, routines and how their last run ended, and the replies that failed in the last week with their error, never what was said in conversations. When he mentions a screen, the message shows a button that opens it. A Tuca made before is brought up to date when the app starts, unless his instructions were rewritten by hand.

## [0.2.12] - 2026-11-05

> **Em português:**
> - **Workspaces.** Empresa e emprego, por exemplo, separados: cada workspace tem seus agentes, conversas, conectores, memórias e rotinas, e um não vê o outro. Você troca pelo nome no topo da barra lateral, e as rotinas de todos continuam rodando. Ao criar um, você escolhe o que levar do atual.
> - **Agentes no Grok.** Um agente pode rodar no Grok CLI, com a assinatura do grok.com, como roda no Cursor CLI. Cada resposta usa uma pasta própria: os seus plugins, skills e hooks não carregam, e só as ferramentas do Tucano ficam à mão.
> - **Os agentes do Claude respondem mais rápido e gastam menos do plano em conversas longas.** Cada agente continua a mesma sessão do Claude Code na conversa e manda só o que é novo; entre uma resposta e outra o processo fica aberto por 5 minutos. O primeiro trecho da resposta chega quase 1 segundo antes, e uma conversa longa não é mandada inteira de novo a cada resposta.
> - **A resposta começa enquanto você digita.** O Tucano já abre o Claude Code de quem vai responder: o router escolhe quem responde num canal em 1,5 s em vez de 2,8 s, e numa DM parada há mais de 5 minutos a resposta começa meio segundo antes.
> - **Os passos mostram o que o agente fez.** Cada consulta mostra o SQL ou o que foi pedido, e o que voltou ("120 linhas"); um comando mostra o comando inteiro, e o SQL quando roda um; uma skill diz qual foi lida. Tudo aparece enquanto o agente trabalha, sem nenhum segredo na tela.
> - **Um agente só acorda outro quando precisa.** Quando um agente menciona outro na resposta, o router lê e chama só quem tem algo a fazer: um agradecimento ou um “combinado” não acordam ninguém. Na dúvida, chama.
> - **Uma triagem de alarmes leva minutos, não meia hora.** Uma consulta de conector que volta ainda rodando (um SQL demorado) o app espera sozinho, com a ferramenta de status do conector, em vez de o agente dormir e perguntar de novo; um agente com conectores lê só a janela que precisa, e é avisado quando pagina um histórico inteiro.
> - **Um agente responde uma vez de cada vez na mesma conversa.** Quando outro agente passa a vez pra quem já está respondendo ali, não abre uma segunda resposta ao lado: fica anotado, e quando a resposta acaba vem uma só, que lê tudo o que chegou no meio. Em outras conversas e threads ele segue em paralelo.
> - **Um conector que falha diz por quê.** O passo da resposta mostra o motivo em vermelho, e o agente recebe o mesmo motivo pra explicar, em vez de um ✗ sem nada.
> - **As novidades vêm em páginas,** como esta: quatro tópicos por vez, com setas pra passar.
> - **Correções.** Uma rotina que roda ao abrir o app espera os conectores, um conector com login OAuth não pede pra entrar de novo a cada abertura, conversas longas não pesam enquanto um agente responde, o navegador dos agentes abre páginas num servidor Linux, a página do servidor abre por HTTP num endereço privado, o app abre fora do instalador, e o tucano aparece na dock do Linux.
>
> Obrigado ao Bruno, ao Dias, ao Alan, ao Matheus, ao Gian, ao João Vitor, ao Daniel, ao Cleiton e ao Luan!

### Added

- **Workspaces.** Keep a company and a day job, say, apart: each workspace has its own agents, conversations, connectors and credentials, memories, routines, engine folders and browser sessions, and none sees another's. Switch from the name at the top of the sidebar, which shows the others' unread and pending approvals (and nothing else of them); every workspace's routines and triggers keep running while another is on screen, each on its own webhook and git proxy ports. Creating one asks what to bring from the workspace you're in, each ticked on its own: the general settings (your name, language, router and memory models, limits, quiet hours), the context, the wiki (the same one, not a copy: what one keeps the other reads), agents, channels, skills, connectors with their credentials, routines. What depends on something left behind comes without it (agents without connectors have no grants), and with nothing ticked it starts empty with the introduction. Duplicating ticks everything; never messages, memories or usage. Settings › General names the workspace apart from what the agents call you, and its Danger area deletes a workspace with all its data, Claude Code's transcripts of its agents included. The folder you had is the default workspace, unchanged, and keeps Telegram and opening at login. It's a separation of data, not an OS sandbox: an agent on your computer still reaches the same disk. Thanks [@b7s](https://github.com/b7s)! ([#63](https://github.com/eduwxyz/tucano/pull/63))
- **Agents on Grok.** An agent can run on the [Grok CLI](https://x.ai/cli) with a grok.com subscription, the way it runs on Cursor CLI: sign in with `grok login` and pick a Grok model. Each reply runs in a folder and a home of its own, so your MCP servers, skills, hooks and plugins (Grok's and the ones installed for Claude Code or Cursor) don't load, Grok's own shell and files stay off, and Tucano's tools are the only ones it has. An `XAI_API_KEY` in the environment is set aside when grok.com is signed in, so the subscription isn't billed per token. The official installer is macOS and Linux. Thanks [@matheus-apolonio](https://github.com/matheus-apolonio)! ([#87](https://github.com/eduwxyz/tucano/pull/87))

### Changed

- **What's new after an update comes in pages.** A big release was one long list to scroll; it now shows four topics at a time, with arrows (and ← →) to turn them, and the same window height on every page.
- **An alarm triage takes minutes, not half an hour.** A connector query that comes back still running (a slow Databricks SQL statement) is now awaited by the app with the connector's own status tool, backing off from 2 to 15 s for up to five minutes, and the agent gets the finished result in the one call it made, instead of sleeping a minute and asking again. A status tool the agent calls itself, or a write that starts a job, still answers right away. An agent with connectors sees each message's time with the year, the UTC offset and the Unix seconds, and is told to read only the window a task needs (the last hour, for something happening now) and to narrow a cut result before paging the rest, which now says how much was left out. Two guards catch what's left: a connector read called 15 times in a reply gets a note to narrow it, and past 60 it's refused for that reply; and for an agent with connectors, a bare `sleep` of 20 s or more with nothing checked after it runs once per reply. Writes, and a sleep before checking something on the computer, are never counted. A reproduced triage (30 days of alarms in Slack, a 3-minute query) went from 439 agent calls and 40 minutes to 2 calls and 3.4 minutes. Thanks [@rjgdias](https://github.com/rjgdias)! ([#137](https://github.com/eduwxyz/tucano/pull/137))
- **Claude agents reply faster, and long conversations spend less of the plan.** An agent now keeps its Claude Code session for each conversation and thread: its first reply sends the conversation, and the next ones only what's new since (other people's and agents' messages, and the task). The process stays open for five minutes after a reply (two at most at a time), so the next reply skips starting Claude Code. Measured with Haiku in a DM of about 16k tokens, the first words of a reply come about 0.9 s sooner (1.45 s instead of 2.33 s). Past the conversation's window, where each reply used to write the whole history to the prompt cache again (about 16,600 tokens), it now writes about 200. The session starts over when the agent's instructions, memories or tools change, a message it saw is edited, its last reply was stopped or failed, or after an hour idle. Thanks [@rjgdias](https://github.com/rjgdias)! ([#147](https://github.com/eduwxyz/tucano/pull/147))
- **Replies get going while you type.** As you write, Tucano starts Claude Code for whoever will answer, so the reply doesn't wait the second it takes to start: in a channel of several agents, a process for the router, which then picks who answers in about 1.5 s instead of 2.8 s; in a DM whose agent's process closed after its five idle minutes, that process again, and the first words come about 0.6 s sooner. A process started for the router that goes unused (you mentioned someone, or didn't send) closes after two minutes. Thanks [@rjgdias](https://github.com/rjgdias)! ([#148](https://github.com/eduwxyz/tucano/pull/148))
- **A reply's steps say what each call did, as it runs.** A connector call shows what it asked (the SQL, a path, a search) from the moment it starts, and what came back once it ends, in a few words: the rows of a table or a SQL answer, the items of a list, the lines of a long text. A command shows whole, or as **Ran SQL** with the SQL taken out of it, and ends with what it printed or its exit code and the last lines of stderr; reading a skill says which skill and file. Tokens, passwords, keys and auth headers are masked on the screen and in the log (the agent still gets the real output). The steps list stays open while the agent works, unless closed, and folds when the reply is done. Thanks [@rjgdias](https://github.com/rjgdias)! ([#135](https://github.com/eduwxyz/tucano/pull/135))
- **An agent wakes another only when it needs to.** When an agent's reply mentions other agents, the router reads it first and hands the turn only to those asked to do something: a request, a question, a task, a decision. A thank-you, an "okay" or a credit wakes no one, and the decision shows as a step on the reply. In doubt, or if the router fails, everyone mentioned is called, as before; a mention in your own message still goes straight to the agent. Thanks [@eialanjones](https://github.com/eialanjones)! ([#139](https://github.com/eduwxyz/tucano/pull/139))

### Fixed

- **An OAuth connector stays signed in across launches.** The app listens for the sign-in callback on a new port each launch, and a saved registration was used only for the exact address it was made with, so every launch registered the app again and the refresh token, which belongs to the client that got it, was refused: the connector asked to sign in again. A loopback address now matches whatever its port (RFC 8252), so the connector refreshes on its own. A new sign-in still registers with the exact address, for servers that want it. Thanks [@GianCdM](https://github.com/GianCdM)! ([#100](https://github.com/eduwxyz/tucano/pull/100))
- **A routine that runs as the app opens finds its connectors.** Routines missed while the app was closed, and any due right as it opens, ran on the first check, before the connectors had finished connecting: the agent was told its tools were offline and ran without them. A routine now waits for the connectors still connecting, up to a minute, then runs anyway (with a line in the log); with none connecting it starts at once, as before. Thanks [@jvitorcarvalho](https://github.com/jvitorcarvalho)! ([#152](https://github.com/eduwxyz/tucano/pull/152))
- **An agent replies once at a time in the same conversation or thread.** When another agent handed the turn to one already replying there, a second reply of it started next to the first, each working from the conversation as it was when it began. The hand-off is now noted instead, and the caller's step says so ("already replying here, will see this next"); when the current reply ends well, one follow-up reply reads everything that came in meanwhile, in the same Claude Code session. A reply that stopped, failed, hit a limit or waits on you gets no follow-up, since you act there anyway. The same agent elsewhere still runs in parallel, and the hand-off router is told who is already replying, and that waiting for someone's update isn't a request. Thanks [@eialanjones](https://github.com/eialanjones)! ([#151](https://github.com/eduwxyz/tucano/pull/151))
- **A connector tool that fails says why.** The reply's step showed a bare ✗ next to the tool's name, and for some failures the agent got an empty result too. The step now shows the reason under its label (a few lines, all of it on a click), and the agent gets it: a reason only in the structured content or an embedded resource, an MCP error's code and data, a timeout in seconds, a result that doesn't match the tool's schema, or a session that couldn't reconnect. An approved call and a routine's poll say it the same way. Thanks [@rjgdias](https://github.com/rjgdias)! ([#133](https://github.com/eduwxyz/tucano/pull/133))
- **Long conversations stay light while an agent replies.** Each streamed word redrew and re-parsed every message in the list, keeping the window busy on long conversations. Now only the message that changed is drawn again. Thanks [@Luan1Schons](https://github.com/Luan1Schons)! ([#132](https://github.com/eduwxyz/tucano/pull/132))
- **An agent's browser loads pages on a Linux server that is a desktop PC.** Chrome waited for the desktop's locked keyring before its first page and never got it, so every page hung. On a server it now uses its own cookie store; a desktop keeps the keyring. Thanks [@daniellcar](https://github.com/daniellcar)! ([#143](https://github.com/eduwxyz/tucano/pull/143))
- **The server's page opens over plain HTTP on a private address,** such as Tailscale or a home network. It stayed blank: a browser outside a secure context has no `crypto.randomUUID`, which the app calls as it starts. The page now brings a small replacement for it, and one for the copy buttons. Thanks [@daniellcar](https://github.com/daniellcar)! ([#142](https://github.com/eduwxyz/tucano/pull/142))
- **The toucan shows in the Linux dock and app menu.** The .deb showed a generic gear: the icon was a single 1024 px image, under a size the icon theme doesn't list, so the dock found nothing. It now installs the toucan at every size from 16 to 1024 px. Thanks [@cleitoncsalvagni](https://github.com/cleitoncsalvagni)! ([#140](https://github.com/eduwxyz/tucano/pull/140))
- **The app opens unpacked even when its version isn't one the updater accepts.** The updater was made as the app started, and making it checks the version, so an unpacked build reporting one like `0.0` stopped before its window opened. It's now made only when updates are on. Thanks [@b7s](https://github.com/b7s)! ([#123](https://github.com/eduwxyz/tucano/pull/123))

## [0.2.11] - 2026-11-05

> **Em português:**
> - **As respostas voltam pra conversa.** Os agentes respondem logo abaixo da mensagem, como num chat. Quem prefere threads liga nas configurações do canal, que abrem clicando no nome dele no topo.
> - **Conectores prontos.** 34 serviços, como Notion, Sentry, Vercel, Jira, Stripe e Canva, conectam com um clique e o login no navegador. Os outros continuam em Adicionar personalizado.
> - **Novidades na tela.** Depois de uma atualização, o Tucano mostra uma vez o que entrou na versão, no idioma do app.
> - **Menções com cara de agente.** Um @nome vira uma etiqueta com a cor e a foto do agente, na mensagem e enquanto você digita.
> - **Cada thread fica na dela.** Um agente numa thread não mistura o que acontece nas outras, e procura nelas quando você fala de outra conversa.
> - **Respostas do Claude mais rápidas.** Terminam uns 2 segundos antes, às vezes 10.
> - **Conectores ficam conectados.** Uma conexão que cai volta sozinha, e um resultado longo chega inteiro ao agente.
> - **Docker desligado é avisado na hora.** O agente para na primeira tentativa e diz o que fazer, em vez de tentar ferramenta por ferramenta.
> - **Correções.** Uma thread abre na mensagem mais recente e cabe na tela, uma aprovação decidida durante a resposta não se perde, uma hora cheia do calendário cresce em vez de empurrar rotinas, o cargo longo de um agente quebra a linha, e o ditado ficou mais arrumado.
>
> Obrigado ao Dias, ao Alan, ao Cleiton e ao Bruno!

### Added

- **Connectors ready to add.** **Connectors** lists 34 services by category (development, projects and tasks, business and data, design and websites, research, finance), each through its official MCP server: Notion, Sentry, Vercel, Cloudflare, Jira and Confluence, Stripe, PostHog, Canva and more. **Connect** opens the sign-in in the browser right away, the access stays on this computer, and what's already added says so. A search finds a service by name or by what it does. Anything else goes in with **Add custom**, as before. ([#128](https://github.com/eduwxyz/tucano/pull/128))
- **What's new, after an update.** The first time Tucano opens on a new version, a window in the middle of the screen shows what came in, in the app's language, once. Skipping versions shows the ones skipped too, up to three, and **See the full notes** opens the release page. A new install doesn't show it. ([#127](https://github.com/eduwxyz/tucano/pull/127))
- **@mentions are chips** with the agent's color and picture, in the messages and in the field as you type. Thanks [@rjgdias](https://github.com/rjgdias)! ([#109](https://github.com/eduwxyz/tucano/pull/109))

### Changed

- **Answers come in the conversation again, and threads are a choice of each conversation.** Since 0.2.10 every message opened a thread with its answers. Now a channel or a DM answers in the conversation, like a chat, unless its settings say **In threads, one per message**: then each message opens a thread with its answers, as before. The settings open from the conversation's name at its top or from its menu in the sidebar, and hold a channel's name and topic too; a new channel asks where its agents answer. A thread you open by hand, with a message's reply button, works either way, and the threads you already have stay as they are. An answer in the conversation reads the conversation and the message that opened each thread; what was said inside a thread it looks up when it needs it, as it does from another thread. ([#126](https://github.com/eduwxyz/tucano/pull/126))
- **Each thread keeps to itself.** An agent replying in a thread reads that thread only, not the conversation's other threads, so two subjects in parallel no longer mix. When you mention another conversation, it looks the others up with `buscar_threads` and `ler_thread`. A long thread gets a summary of its own, and the memories in it are kept once it grows or goes quiet; the book button in its header shows and edits that summary. ([#120](https://github.com/eduwxyz/tucano/pull/120))

### Fixed

- **A thread opens at its latest message,** like in Slack, instead of at the message that started it: a long thread no longer has to be scrolled all the way down to see where it is. Scrolling up still stays put when a reply comes in. Thanks [@rjgdias](https://github.com/rjgdias)! ([#119](https://github.com/eduwxyz/tucano/pull/119))
- **The thread panel stays inside its bounds,** and a button takes you back to the end of a conversation you scrolled up in. Thanks [@cleitoncsalvagni](https://github.com/cleitoncsalvagni)! ([#107](https://github.com/eduwxyz/tucano/pull/107))
- **An approval decided while the agent is still replying stays decided;** the reply's last save used to put it back to waiting. Thanks [@eialanjones](https://github.com/eialanjones)! ([#122](https://github.com/eduwxyz/tucano/pull/122))
- **Claude replies finish about 2 seconds sooner, at times 10.** After each reply Claude Code made one more model call, a summary of the turn that Tucano never reads, and only then said it was done and exited. That call is now off for the Claude Code that Tucano runs, so a reply ends when its text does, and what waits on it (the next agent in line, a team's report) starts right away. Your own Claude Code in the terminal isn't touched. Thanks [@rjgdias](https://github.com/rjgdias)! ([#108](https://github.com/eduwxyz/tucano/pull/108))
- **Agents see what a connector returns, even when it's long.** A result over Claude Code's own cut (about 50 KB, like the comments of a big merge request) was saved to a file the agent can't read, so it called again and again and answered without the data. Tucano now cuts a result at 40 KB, counted in bytes so accents don't push it over, and tells the agent to ask again with pagination or a filter if it needs the rest. Thanks [@rjgdias](https://github.com/rjgdias)! ([#108](https://github.com/eduwxyz/tucano/pull/108))
- **Connectors stay connected.** A local connector whose process ended (a crash, or one that quits when idle) stayed **Disconnected** for good, and its tools went away from the agents, so nothing ever brought it back; and a remote one whose server forgot an idle session failed every call while still showing **Connected**. Now a connection that drops on its own comes back by itself, after a wait that grows from 2 seconds to 5 minutes, and a call on a forgotten session opens a new one and goes through. A connector that's only reconnecting keeps its tools; one that needs you (a refused token, a sign-in to finish) doesn't, and isn't retried. Thanks [@rjgdias](https://github.com/rjgdias)! ([#114](https://github.com/eduwxyz/tucano/pull/114))
- **An agent stops at once when its computer can't run.** With Docker off, out of reach or not installed, every command and file read failed, and the agent tried tool after tool, spending tokens to find out the same thing. Now the first call that finds Docker down ends the reply, which says what to do (start Docker, join the docker group, install it) and can be tried again. While Docker stays off, the next replies don't get the computer's tools at all: the agent is told it's down and says so in a sentence, answering what it can without it. A Docker that doesn't answer at all counts as down too, like one that's off. Thanks [@rjgdias](https://github.com/rjgdias)! ([#112](https://github.com/eduwxyz/tucano/pull/112))
- **A crowded hour on the routines calendar grows** to fit what's in it, instead of pushing routines into the hours after. Thanks [@eialanjones](https://github.com/eialanjones)! ([#105](https://github.com/eduwxyz/tucano/pull/105))
- **A long agent role wraps** in its card instead of spilling out of it. Thanks [@cleitoncsalvagni](https://github.com/cleitoncsalvagni)! ([#103](https://github.com/eduwxyz/tucano/pull/103))
- **The dictation settings are spaced out,** the advanced part folds, and switches turn on in the app's accent color. Thanks [@b7s](https://github.com/b7s)! ([#124](https://github.com/eduwxyz/tucano/pull/124))

## [0.2.10] - 2026-11-04

> **Em português:**
> - **Threads.** Cada resposta a uma mensagem, e o que ela dispara, fica na thread dela, que abre na lateral. Na conversa aparecem só as mensagens que abriram uma thread, com quem participou, quantas respostas e o que espera por você.
> - **Um "bom dia" chama todo mundo.** Uma mensagem pro grupo chama todos os agentes do canal.
> - **Ditado.** Clique no microfone, fale e clique de novo, e o texto cai no campo pra você revisar. Tudo roda no seu computador, sem internet, e o modelo baixa com um clique.
> - **Canais em grupos.** Os canais podem ser arrastados e organizados em grupos que recolhem.
> - **Caminhos de arquivo viram link** na mensagem de um agente.
> - **Token de conector.** Dá pra trocar o token sem remover o conector.
> - **Erros mais claros.** Dizem o que aconteceu e o que fazer.
> - **Correções.** Os agentes no Gemini passam a ler as configurações do Tucano, o modelo reserva entra no limite de 5 horas do Claude Code, as rotinas mandam a resposta inteira pro Telegram e, no Windows, o Tucano não trava mais a atualização de outros apps.
>
> Obrigado à Rayanne, ao Gabriel, ao Alan, ao Cleiton e ao Kayo!

### Added

- **Threads.** Every answer to a message, and what it sets off (routing notes, questions, approvals, replies between agents), goes in the thread of that message, and you can reply there too. The conversation shows the messages that started a thread, each with a pill: who took part, how many replies, when, what's new and what waits on you. The thread opens on the side, and Esc closes it. An agent reads the conversation's recent messages plus the whole thread it replies in. A question waits in its thread and is answered from inside it, while what you write in the channel stays in the channel. Notifications open the thread, and an answer from Telegram goes back to it. Your existing messages stay in the conversation as they were. ([#101](https://github.com/eduwxyz/tucano/pull/101))
- **A greeting reaches everyone.** A message meant for the whole group, like a "good morning", can call every agent in the channel, past the usual two. ([#101](https://github.com/eduwxyz/tucano/pull/101))
- **Dictation.** Click the microphone in the message field, or press ⌥ Space on a Mac and Ctrl+Space elsewhere, speak, and click again; holding it and letting go works too, and Esc cancels. The audio becomes text on this computer, offline, with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and the text stays in the field for you to review; it's never sent on its own. `whisper-cli` comes inside the app, and the first click offers a model to download (Recommended, 574 MB, or Light, 190 MB), checked before it's kept. **Settings › General › Dictation** switches or removes the model and hides the microphone, and a whisper you installed yourself still works. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#60](https://github.com/eduwxyz/tucano/pull/60))
- **Reorder and group channels.** Drag a channel, or use **Move up** and **Move down** in its menu, and put channels in groups that fold, like the sidebar's sections. Removing a group never deletes a channel. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#77](https://github.com/eduwxyz/tucano/pull/77))
- **File paths in agents' messages are links,** when the file exists and that agent can reach it: an image or video opens in the app, a folder or PDF in the system, anything else is shown in the file manager, and nothing is run. The app's data, other agents' folders and places like `.ssh` never become links. Off on a server, and on Windows for now. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#61](https://github.com/eduwxyz/tucano/pull/61))
- **Change a connector's token without removing it.** A connector that signs in with a token has a field to save a new one, which reconnects, and a refused token no longer offers a browser sign-in that can't work for it. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#80](https://github.com/eduwxyz/tucano/pull/80), [#99](https://github.com/eduwxyz/tucano/pull/99))

### Changed

- **Errors in plain words.** A failure says what happened and what to do (signed out, plan limit and when it frees up, offline, a missing command, a full disk, a service down), with the raw text folded underneath. Actions that fail show a toast, the app warns when its core stops, confirmations use the app's own dialog, and approvals show tool names as words with a short summary of the arguments. ([#96](https://github.com/eduwxyz/tucano/pull/96))
- **Gemini models come from your Gemini CLI,** read from the installed package, so newer ones show up; the fixed list stays as a fallback. Thanks [@simionatoambrosio](https://github.com/simionatoambrosio)! ([#90](https://github.com/eduwxyz/tucano/pull/90))
- **The wiki keeps knowledge, not a record of the task.** The curator leaves out what an agent did and keeps what changed (a new phone number replaces the old one on its page), and the review flags pages that read like a log and offers to condense them. ([#95](https://github.com/eduwxyz/tucano/pull/95))

### Fixed

- **Agents on Gemini pick up Tucano's settings,** so they reach Tucano's tools and follow the access you gave them. Thanks [@simionatoambrosio](https://github.com/simionatoambrosio)! ([#89](https://github.com/eduwxyz/tucano/pull/89))
- On Windows, Tucano no longer **keeps other Electron apps' `app.asar` open** while listing apps, which made their updates fail (T3 Code, Obsidian, Bruno…). Thanks [@kayotimoteo](https://github.com/kayotimoteo) for the diagnosis! ([#97](https://github.com/eduwxyz/tucano/issues/97), [#98](https://github.com/eduwxyz/tucano/pull/98))
- The **reserve model takes over on Claude Code's 5-hour and weekly limits**; it only knew the general limit message. Thanks [@eialanjones](https://github.com/eialanjones)! ([#88](https://github.com/eduwxyz/tucano/pull/88))
- A **routine's whole reply goes to Telegram**, split between lines into several messages, instead of the 140-character summary; the desktop notification stays short. Thanks [@cleitoncsalvagni](https://github.com/cleitoncsalvagni)! ([#84](https://github.com/eduwxyz/tucano/pull/84))

## [0.2.9] - 2026-11-03

> **Em português:**
> - **Wiki.** O que você e o seu time sabem, em páginas ligadas, que os agentes consultam antes de responder e citam.
> - **Curador.** Lê as conversas e os documentos que você traz (PDF, Word, planilha, link ou anotação) e escreve nas páginas, citando de onde veio. Mudar uma página que já existe espera a sua aprovação, se você quiser.
> - **Mapa e revisão.** A wiki aparece como um mapa que você arrasta, e uma revisão aponta o que não bate, o que ficou velho e o que está repetido.
> - **Obsidian.** A wiki é uma pasta de Markdown que o Obsidian abre, e um cofre que você já tem entra como está, com pastas, links e anexos.
> - **Agentes do OpenBot e do Grok Bot** podem ser trazidos pro Tucano.

### Added

- **A wiki.** What you and the team know, as linked pages, one wiki per workspace and separate from Memory. The pages are a folder of plain Markdown that Obsidian opens as is; Tucano indexes it for search, links and history, and picks up edits made in other apps. Agents read it before answering and cite pages as `[[Title]]`; each agent's page can turn its access off. ([#94](https://github.com/eduwxyz/tucano/pull/94))
  - **A curator** (the memory's model) reads a conversation once it settles, and the files, links and notes you bring in: PDF, Word, spreadsheets, CSV, text and web pages, with the original kept. It writes what lasts into the pages and cites the source. New pages go in right away; a change to a page that exists waits for you, or goes in on its own, as you set. Every change has history and Undo, and one made on a page that changed since can be redone on the newer version. Capture can be turned off for a channel or a DM, and **Keep in the wiki** on a message keeps it on purpose.
  - **A map** of the pages: drag it, zoom it, pull a page and the ones it links to follow. A page opens in a panel over it; links show a preview on hover; ⌘K (Ctrl K) searches.
  - **A review**, by hand or once a week: broken links, names that several pages mention with no page of their own, pages nothing links to, and, read by the model, pages that disagree, facts that got old and duplicates. All of it waits for you as suggestions.
  - **Import an Obsidian vault** as it is: folders, frontmatter (tags, aliases and the rest are kept on edit), links with paths, aliases and headings, and attachments. The vault itself isn't changed. The wiki can also point at a vault in place.
  - The wiki isn't part of a team export.
- **Import agents from OpenBot and Grok Bot.** **Settings › Team & backup › Import from another app…** reads OpenBot's transfer export, and a zip that a Grok Bot agent makes with a skill Tucano gives you (experimental). Agents keep their name, role, instructions, photo, color and skills; they arrive with no connectors, web search off, routines off and memories waiting for your confirmation, and are never added to a channel that already exists. A summary lists what came in, what was left out and why. ([#91](https://github.com/eduwxyz/tucano/pull/91))

## [0.2.8] - 2026-11-03

> **Em português:** os agentes agora também rodam no Cursor CLI, na sua conta do Cursor, com a mesma governança dos outros: só as ferramentas do Tucano, limite de gasto e nada dos seus hooks, plugins ou skills pessoais. Uma imagem do chat abre do tamanho da janela, com zoom, e as setas passam pelas outras imagens da conversa. Cada agente pode ter uma cor própria, uma foto ou um personagem desenhado do Open Bot Avatar, que se mexe e pisca. E cada agente tem o seu limite de rotinas ligadas, em vez de 10 pra todos. Obrigado à Rayanne e ao b7s!

### Added

- **Cursor CLI.** Agents can run on [Cursor CLI](https://cursor.com/cli), on your Cursor account, with the same governance as the other harnesses: Cursor's own file reads, writes and shell stay off, only Tucano's tools load, and spend comes from the usage Cursor reports. Each reply runs with a home folder of its own, so your hooks, plugins, skills and `~/.cursor/mcp.json` servers don't load. Images attached in the chat go along with the message. Each reply adds about 10k tokens of Cursor's own prompt, and the per-reply budget can't pause a Cursor reply midway, since Cursor reports usage only at the end. ([#79](https://github.com/eduwxyz/tucano/pull/79))
- **Images open the size of the window.** Clicking an image in the chat opens it over the whole window: the wheel zooms where the pointer is, dragging moves it, a double click switches between fit and actual size, and the arrow keys go through the conversation's other images. Esc or a click outside closes it. HTML, documents and videos still open in the side panel. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#58](https://github.com/eduwxyz/tucano/pull/58))
- **An agent's own color or picture.** An agent's page has a color picker next to the eight colors, and takes a PNG, JPEG or WebP that replaces the face wherever the agent shows. A picture stays on its computer and isn't part of a team export. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#59](https://github.com/eduwxyz/tucano/pull/59))
- **Drawn avatars.** An agent can also be one of 22 characters from [Open Bot Avatar](https://github.com/DominikScholz/open-bot-avatar), in the agent's color, on its page and in onboarding. Large ones move and blink, follow the pointer with their eyes, and look like they're thinking while the agent works. A team export carries the character and the color. ([#76](https://github.com/eduwxyz/tucano/pull/76))
- **A routine limit for each agent.** **Harness and model › Max. enabled routines** sets how many routines an agent can have on at once, 10 by default; it was 10 for every agent. Thanks [@b7s](https://github.com/b7s)! ([#66](https://github.com/eduwxyz/tucano/pull/66))

## [0.2.7] - 2026-11-02

> **Em português:** cada agente pode ter um modelo reserva: quando a assinatura do modelo principal chega no limite, a resposta continua no reserva em vez de parar com erro, e a seguinte já volta pro principal. Dá pra entrar com mais de uma conta do Claude Code e do Codex (a do trabalho e a pessoal, por exemplo), escolher a conta de cada agente e usar uma outra conta como reserva. O Tucano agora também sai pra Mac com Intel. E um botão em Configurações desliga o som das notificações.

### Added

- **A reserve model for each agent.** On an agent's page, **Harness and model › Reserve model**, off by default. When the main model's subscription is out (Claude Code's 5-hour or weekly limit, Codex's usage limit, Gemini's quota or a provider's 429), the reply goes on with the reserve instead of stopping with an error. It moves only when the main model failed before doing anything, so no action runs twice, and only once per reply: the next reply starts on the main model again. The reply's steps show the move. ([#70](https://github.com/eduwxyz/tucano/pull/70))
- **More than one Claude Code or Codex account.** **Settings › Models › Accounts** adds more logins, like a work account beside a personal one, and each agent picks its account on its page. You sign in through the CLI itself, in a terminal; Tucano never sees the credentials. An agent on an account that's signed out says so, instead of falling back to your usual login. The subscription windows shown in the app are still the usual login's. Accounts stay on this computer and aren't part of a team export. ([#71](https://github.com/eduwxyz/tucano/pull/71))
- **The reserve can be another account** of the same harness: when one Claude Code account is out, the agent goes on with the same model on another. Turning the reserve on picks another account of the main harness, when there is one. ([#72](https://github.com/eduwxyz/tucano/pull/72))
- **Intel Macs.** Tucano is released for Intel Macs too (`tucano-mac-x64.dmg`), and the Terminal install picks your chip's build, even in a Terminal running under Rosetta. ([#69](https://github.com/eduwxyz/tucano/pull/69))
- A **Sounds** switch in **Settings › General › Notifications** turns the chirp off; notifications still show. Muting Tucano in the system didn't stop it. ([#67](https://github.com/eduwxyz/tucano/pull/67))

## [0.2.6] - 2026-11-01

> **Em português:** agora dá pra recolher as seções da barra lateral (canais, mensagens diretas e agentes), e uma seção recolhida continua mostrando as não lidas. E uma leva de correções, quase toda da comunidade: o Chrome do agente não perde mais um login recente ao fechar, agentes num modelo do Gemini rodam mesmo no Gemini (antes caíam no Claude), "Tentar de novo" numa rotina lembra o evento que a disparou, links longos não saem mais da conversa, e, nos apps do computador, os rótulos seguem o seu idioma e um texto com "ã" não chega mais pela metade. Obrigado à Rayanne e à Brisa!

### Added

- **Fold the sidebar's sections.** Channels, direct messages and agents each fold from their header. A folded section stays folded after a restart, keeps its **+** button and shows its unread count, and the conversation you're in stays visible in it. Thanks [@BrisaTielly](https://github.com/BrisaTielly)! ([#62](https://github.com/eduwxyz/tucano/pull/62))

### Fixed

- An agent's **Chrome keeps a recent login** when it closes, including one you made by hand after taking the browser over. Tucano now asks Chrome to close and waits for it, instead of killing it before it saved its cookies. A login made right before quitting Tucano can still be lost. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#53](https://github.com/eduwxyz/tucano/pull/53))
- Agents on a **Gemini** model run on Gemini; they fell back to Claude. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#47](https://github.com/eduwxyz/tucano/pull/47))
- Tuca proposes agents on **Gemini** models too, from what your signed-in Gemini CLI lists. ([#50](https://github.com/eduwxyz/tucano/pull/50))
- **Try again** on a routine's reply runs it with what it was asked, the event that triggered it or its scheduled instructions; the agent started without them. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#54](https://github.com/eduwxyz/tucano/pull/54))
- **Long links and words** break inside a message instead of pushing it out of the conversation, and a wide table scrolls by itself. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#48](https://github.com/eduwxyz/tucano/pull/48))
- Typing key by key in an app, a character with no key (such as "ã") no longer **vanishes from the text**: nothing is typed, and the agent is told which characters, so it can write them another way. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#57](https://github.com/eduwxyz/tucano/pull/57))
- The labels of **app actions** follow the language you chose, not the one Tucano started in. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#56](https://github.com/eduwxyz/tucano/pull/56))
- The model Codex ranks first (priority 0) stays at the **top of the list** instead of going to the end. Thanks [@rayanneblima](https://github.com/rayanneblima)! ([#55](https://github.com/eduwxyz/tucano/pull/55))

## [0.2.5] - 2026-11-01

> **Em português:** os agentes agora usam os apps do seu computador, como Notas, Calendário e Spotify, no Mac, no Windows e no Linux. Você escolhe quais apps cada agente usa e se ele só lê ou também mexe. Ele lê a janela pela acessibilidade do sistema e clica e escreve sem mexer no seu mouse, e o que envia, paga, publica, agenda ou apaga espera a sua aprovação. Feito sobre o agent-desktop, open source da Vercel Labs. Obrigado!

### Added

- **Your own apps.** On an agent's **Tools** tab, **Computer apps** gives it apps on your computer, each **read only** or **read and use**, picked from your system's own list, with their icons, open ones first. The agent opens an app, reads its window as a numbered list, and clicks, writes and presses keys in it, without moving your mouse. A click or key that sends, pays, publishes, schedules or deletes, and Return right after writing, asks for your approval, showing what it would confirm; an approval lets that one action through. On macOS (it needs the Accessibility permission), Windows (Start menu and Store apps) and Linux (the application menu, through AT-SPI). It runs on [agent-desktop](https://github.com/vercel-labs/agent-desktop) by Vercel Labs, which Tucano can install for you. ([#31](https://github.com/eduwxyz/tucano/pull/31))

### Fixed

- An approved step no longer shows as **failed** in a reply's steps. ([#31](https://github.com/eduwxyz/tucano/pull/31))

## [0.2.4] - 2026-11-01

> **Em português:** o Codex mostra os modelos que a sua conta tem, os mais novos primeiro (como o GPT-6-Astra), em vez de três fixos. E no Windows o login dos harnesses ficou mais confiável: funciona com acento no nome do usuário (como `C:\Users\Glaúcia`), e um login ou instalação feito no terminal aparece sozinho no Tucano, sem clicar em "Verificar de novo".

### Changed

- **Codex lists your account's models**, newest first and by their names (GPT-6-Astra, GPT-5.6-Sol…), from Codex's own catalog, instead of a fixed three; Tuca proposes agents from the same list. Agents already on a GPT-5.6 model keep it. ([#33](https://github.com/eduwxyz/tucano/pull/33))

### Fixed

- On Windows, **signing in to a harness works from a user folder with accents** (`C:\Users\Glaúcia`); the sign-in console broke on them. ([#34](https://github.com/eduwxyz/tucano/pull/34))
- A sign-in or an install finished in the terminal **shows up by itself**, on any screen; before, outside onboarding, it waited for **Check again**. ([#34](https://github.com/eduwxyz/tucano/pull/34))
- On Windows, the install command to paste uses `npm.cmd`, which PowerShell runs even where scripts are disabled. ([#34](https://github.com/eduwxyz/tucano/pull/34))

## [0.2.3] - 2026-10-31

> **Em português:** o Tucano agora dá pra usar no celular, abrindo o app de um servidor seu pelo navegador. Uma rotina que falha tenta de novo sozinha, duas vezes, antes de desistir. Os canais mostram quando um agente está trabalhando, e uma resposta que chega enquanto você está fora marca o canal como não lido. Você escolhe o modelo do Tuca, e um papel longo não esconde mais o nome do agente na barra lateral. Obrigado ao Gian, ao Andrey e ao Marcelo!

### Added

- **Use Tucano on a phone.** Opened from a phone (Tucano on a server), the sidebar becomes a drawer behind a ☰ button, the view takes the full width and side panels cover the screen; the conversation, agent page, report, routines and onboarding fit a narrow screen, and inputs don't make iOS zoom. The desktop is unchanged. ([#28](https://github.com/eduwxyz/tucano/pull/28))
- **A failed routine tries again**, twice, after 1 and then 5 minutes, before giving up; the reply says when the next try is, and you're notified once, with the final outcome. Only failures are retried (not a reached limit, an approval or a question), and retrying by hand or turning the routine off stops the tries. ([#30](https://github.com/eduwxyz/tucano/pull/30))
- **Choose Tuca's model** on the screen where you talk to Tuca, in onboarding and when building a new agent. Changing it starts a fresh conversation, and the choice is kept for the next ones. Thanks [@anota-ai-andrey](https://github.com/anota-ai-andrey)! ([#23](https://github.com/eduwxyz/tucano/pull/23))
- **Channels show when an agent is working** in them, with the same pulse as DMs. Thanks [@GianCdM](https://github.com/GianCdM)! ([#21](https://github.com/eduwxyz/tucano/pull/21))

### Fixed

- A reply that finishes **while you're away** from a conversation now marks it unread, even if you were watching when it started. Thanks [@GianCdM](https://github.com/GianCdM)! ([#21](https://github.com/eduwxyz/tucano/pull/21))
- A **long agent role** no longer pushes the agent's name out of the sidebar: it's cut with an ellipsis and shows in full on hover. Thanks [@marcelogrcia](https://github.com/marcelogrcia)! ([#29](https://github.com/eduwxyz/tucano/pull/29))

## [0.2.2] - 2026-10-31

> **Em português:** o Tucano agora roda num servidor seu, como uma VPS, e você usa pelo navegador, do computador ou do celular. As rotinas continuam rodando com o seu computador desligado. Os agentes também passam a rodar no Gemini CLI. E instalar um harness ficou mais fácil: um botão **Instalar** abre o terminal já com o comando, e no Windows o Tucano acha o Claude Code mesmo quando o instalador não o pôs no PATH.

### Added

- **Tucano on a server.** `npm run server` runs Tucano without a window on a machine you own, such as a VPS, and serves the app's own screens to a browser on any computer or phone. Routines keep running while your computer sleeps. Every request needs the server's token, and it listens only on the server itself unless you choose otherwise. Secrets are sealed with a key only the server's user can read. Connectors that sign in with OAuth work there: you paste back the address the sign-in page ended on. To take over an agent's browser, you use its live picture in the panel. Agents' screenshots come from the server's Chrome. On a private network such as Tailscale, the pages agents serve open in the preview panel. Setup, how to reach it (an SSH tunnel, Tailscale or a reverse proxy) and a systemd unit are in [docs/server.md](https://github.com/eduwxyz/tucano/blob/main/docs/server.md). Experimental. ([#27](https://github.com/eduwxyz/tucano/pull/27))
- **Gemini CLI** as a harness: agents run on Google's Gemini models through the Gemini CLI you're signed in to. ([#25](https://github.com/eduwxyz/tucano/pull/25))
- An **Install** button on every harness that isn't installed. It opens a terminal running the harness's own installer: PowerShell on Windows, Terminal on a Mac, your desktop's terminal on Linux. Tucano picks the harness up once it lands. A harness that needs Node.js points you to it first. ([#26](https://github.com/eduwxyz/tucano/pull/26))

### Fixed

- On Windows, **Claude Code shows as installed** even when its installer couldn't add `~/.local/bin` to PATH. Tucano also looks for CLIs where their installers put them (`~/.local/bin`, and npm's global folder on Windows), including a CLI installed while the app is open. ([#24](https://github.com/eduwxyz/tucano/pull/24))

## [0.2.1] - 2026-10-31

> **Em português:** uma versão de correções e acabamentos, quase toda da comunidade. Campos de número que você pode apagar e digitar por cima (antes um `30` virava `530`), rascunho de mensagem que não se perde ao trocar de canal, botão de copiar nos blocos de código, `@menção` dentro de código que não chama mais o agente, suporte ao terminal Ghostty no Linux, e links de mensagem que abrem no seu navegador em vez de cobrir o app. Obrigado ao Gian e ao Fernando!

### Added

- A **copy button** on code blocks in a message, and mentions are no longer bolded inside code (the box shows and copies the real text). Thanks [@GianCdM](https://github.com/GianCdM)! ([#15](https://github.com/eduwxyz/tucano/pull/15))
- A message you were typing is **kept as a draft** when you leave a conversation and comes back when you return. Thanks [@GianCdM](https://github.com/GianCdM)! ([#11](https://github.com/eduwxyz/tucano/pull/11))
- **Ghostty** joins the Linux terminals Sign in can open, with a validation guide for Arch Linux and CachyOS on Niri. Thanks [@nandomoreirame](https://github.com/nandomoreirame)! ([#17](https://github.com/eduwxyz/tucano/pull/17))
- Handing an agent's browser back (**Hand back**, or closing the window) resumes a question it was waiting on, instead of leaving it idle. Thanks [@GianCdM](https://github.com/GianCdM)! ([#18](https://github.com/eduwxyz/tucano/pull/18))

### Fixed

- A link in a message now opens in your **real browser**; clicking one no longer navigates the whole app to the site with no way back. Thanks [@GianCdM](https://github.com/GianCdM)! ([#19](https://github.com/eduwxyz/tucano/pull/19))
- The **number fields** (an agent's monthly limit, the default limit, the ceiling per reply, the stalled-after minutes) can be cleared and typed over; emptying one no longer put `0` back and saved the wrong value. Thanks [@GianCdM](https://github.com/GianCdM)! ([#10](https://github.com/eduwxyz/tucano/pull/10))
- An `@handle` written **inside code** in a reply no longer calls that agent (a prompt an agent quotes could make another answer). Thanks [@GianCdM](https://github.com/GianCdM)! ([#16](https://github.com/eduwxyz/tucano/pull/16))
- An **archived agent** no longer shows up in a channel's agents, count or `@` list, matching what the core already does; it still comes back where it was when you unarchive it. Thanks [@GianCdM](https://github.com/GianCdM)! ([#13](https://github.com/eduwxyz/tucano/pull/13))
- The **harness** an agent runs on shows on its page even when only one harness is in use. Thanks [@GianCdM](https://github.com/GianCdM)! ([#12](https://github.com/eduwxyz/tucano/pull/12))
- Skills installed by the skills CLI (`npx skills`), whose folder is a symlink, now show up on the Skills page. Thanks [@GianCdM](https://github.com/GianCdM)! ([#14](https://github.com/eduwxyz/tucano/pull/14))

## [0.2.0] - 2026-10-30

> **Em português:** o Tucano agora roda no Linux e no Windows. No Linux, em x64 e ARM64: `.deb` pro Ubuntu e o Debian, AppImage pras outras distribuições. No Windows 10 e 11, um comando no PowerShell instala sem pedir administrador e sem aviso do SmartScreen. Nos dois, ele se atualiza sozinho como no Mac, e ao fechar a janela fica na bandeja do sistema, com as rotinas rodando. O app passa a dizer "seu computador" em vez de "Mac". Obrigado ao Eduardo Souza pelo suporte ao Windows!

### Added

- **Linux.** A `.deb` (Ubuntu, Debian and their family) and an AppImage (other distributions), for x64 and ARM64, that update themselves like the Mac app. `install.sh` installs on Linux too. On Linux, Sign in opens your desktop's terminal, closing the window keeps Tucano in the tray so routines go on, Open at login works, passwords go to the system keyring (GNOME Keyring or KWallet, never stored without one), Docker computers give the files they write back to you, and the agents' browser uses Google Chrome or Chromium. ([#5](https://github.com/eduwxyz/tucano/pull/5), [#6](https://github.com/eduwxyz/tucano/pull/6))
- **Windows 10 and 11** (x64). In PowerShell, `irm https://github.com/eduwxyz/tucano/releases/latest/download/install.ps1 | iex` installs Tucano for your user, with no admin rights and no SmartScreen warning, and opens it; the installer is also in each release (it isn't code-signed). It updates itself like the Mac app. Harnesses installed with npm work, agents' commands on your PC run in Git Bash, Sign in opens a console, and closing the window keeps Tucano in the tray, by the clock. Thanks [@edusouza](https://github.com/edusouza)! ([#7](https://github.com/eduwxyz/tucano/pull/7), [#9](https://github.com/eduwxyz/tucano/pull/9))
- Tests run on macOS, Linux and Windows for every pull request. ([#4](https://github.com/eduwxyz/tucano/pull/4), [#9](https://github.com/eduwxyz/tucano/pull/9))

### Changed

- The app says "this computer" and "your computer" instead of the Mac, on every system. Agents are told their real system (macOS, Linux or Windows) and how things install there.
- A new install no longer touches the system's vault when it first opens: the GitHub proxy key is made when you connect GitHub.

## [0.1.2] - 2026-10-28

> **Em português:** o Tucano agora se atualiza sozinho. Esta é a última vez que você baixa uma versão nova à mão: daqui pra frente, ela chega em segundo plano e aparece **Reiniciar** na barra lateral. Também passa a rodar agentes no OpenCode 2 e a achar as skills que plugins do Claude Code declaram fora da pasta `skills/`. Obrigado ao Gian e ao Paulo pelas primeiras contribuições!

### Added

- **Updates itself.** Tucano looks for a new version on GitHub, downloads it in the background and shows **Restart** at the foot of the sidebar when it's ready. If you don't restart, it goes in the next time you quit. Restarting while an agent is working asks first. **Settings › General › Updates** shows your version and has **Check for updates**. This is the last update you install by hand. ([#3](https://github.com/eduwxyz/tucano/pull/3))
- **OpenCode 2.** The OpenCode harness now runs OpenCode 1 and 2, picked by the installed version, so upgrading OpenCode keeps your agents running. On OpenCode 2, agents use your own logins and your company gateway (in either config shape), see Tucano's tools, and count their tokens against their limits. Their sessions don't show up in your OpenCode history. Thanks [@paulo-oliveira-ifood](https://github.com/paulo-oliveira-ifood)! ([#2](https://github.com/eduwxyz/tucano/pull/2))
- **Plugin skills declared in the manifest.** Skills that a Claude Code plugin declares in `.claude-plugin/plugin.json` (`"skills": ["./"]`, as `blader/humanizer` does) now show up on the Skills page, alongside the plugin's `skills/` folder. Thanks [@GianCdM](https://github.com/GianCdM)! ([#1](https://github.com/eduwxyz/tucano/pull/1))

### Changed

- In the setup, harnesses that can't run yet (not installed, or not signed in) start unchecked. ([#2](https://github.com/eduwxyz/tucano/pull/2))

## [0.1.1] - 2026-10-28

> **Em português:** agora assinado e notarizado pela Apple. Baixe o .dmg e abra, sem aviso do macOS.

### Changed

- **Signed and notarized by Apple.** The .dmg opens with no macOS warning, and there's nothing to allow in System Settings.
- Updating from 0.1.0, macOS asks once more for the Keychain, since the signature changed. Click **Always Allow**.

## [0.1.0] - 2026-10-28

> **Em português:** a primeira versão pública. Um time de agentes de IA no seu Mac, que conversa em canais, usa as ferramentas da empresa e pede a sua aprovação antes de mexer no mundo real.

### Added

- First public release: a team of AI agents on your Mac that works in channels, like a work chat.
- Agents run on the Claude Code, Codex, OpenCode or Pi you already have, on your own subscription or your company's gateway.
- Each agent sees only the tools it was given (GitLab, Jira, Slack, Datadog, any MCP server), and anything sensitive waits for your approval of the exact call.
- Receipts and a monthly token limit per agent, reviewed memory, skills, routines on a calendar, and a computer and browser of its own for each agent.
- The app in Portuguese and English.

[0.2.18]: https://github.com/eduwxyz/tucano/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/eduwxyz/tucano/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/eduwxyz/tucano/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/eduwxyz/tucano/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/eduwxyz/tucano/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/eduwxyz/tucano/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/eduwxyz/tucano/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/eduwxyz/tucano/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/eduwxyz/tucano/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/eduwxyz/tucano/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/eduwxyz/tucano/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/eduwxyz/tucano/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/eduwxyz/tucano/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/eduwxyz/tucano/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/eduwxyz/tucano/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/eduwxyz/tucano/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/eduwxyz/tucano/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/eduwxyz/tucano/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/eduwxyz/tucano/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/eduwxyz/tucano/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/eduwxyz/tucano/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/eduwxyz/tucano/releases/tag/v0.1.0
