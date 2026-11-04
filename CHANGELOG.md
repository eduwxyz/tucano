# Changelog

What changed in each version of Tucano. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org) (while in 0.x, a minor version may change things). Each section is also the release's notes on GitHub, which is what the app's "What's new" link opens.

## [Unreleased]

> **Em português:** os agentes agora passam trabalho uns pros outros, como pessoas num Slack. Um agente pode coordenar uma equipe: você manda um pedido grande pra ele, ele delega cada parte pro agente certo, e quando todos terminam ele retoma sozinho pra conferir e te dar o retorno: o resultado, quem fez o quê, o que foi decidido e aplicado, e o que ficou pendente. A sua DM com um agente é só sua: o trabalho entre eles acontece numa DM entre os dois agentes, que você pode ler: uma por dupla de agentes, com cada pedido numa thread, e quem trabalha num pedido vê só a thread dele. E tudo o que um pedido envolve divide um teto de tokens.

### Added

- **Agents hand work to each other.** Every agent gets a `delegar` tool to hand a task or a question to another agent (up to 4 per reply) and end its reply; the others work in parallel, each on its own model, tools and limits. Once every task is settled, the agent gets the results back in a new turn of its own, without polling, to check them, delegate fixes or report back. A delegate may delegate too, up to 3 levels deep, never handing work back up; an agent sends work back at most 4 times in a row before it has to answer.
- **A team, a report, and a private DM.** On an agent's page, **Channels, team and skills › Team** picks the agents it coordinates: they're listed first in its prompt, with what they do, and it's told to split up the work and report back. Its report, marked **Team report**, covers the result, who did what, what was decided, what was actually applied and where, and what's left or needs your decision, with each task's outcome and a link to its conversation underneath. Work asked from your DM with an agent happens in a **DM between the two agents**, under **Between agents** in the sidebar, where you can read along and answer their questions. There's one per pair of agents, and each request is a thread in it: the agent working on one sees only that thread, never an older request's work, and you can delete the DM (right-click) when nothing's running in it; your DM shows one line per task with how it's going. Asked from a channel, it happens in the channel. When the work comes back but nobody is called to report (paused, stopped, archived), your DM says so. A team export carries who coordinates whom, by handle.
- **A ceiling per request.** Everything one request sets off with `delegar` shares a token budget, 1M counted tokens by default (**Settings › Agents › Limits**). Past it, no more work is handed out and the agent reports back with what it has.
- **Agents called together split the work.** Mention two or three agents in one message (or let the router pick two) and they answer one after another in the thread, not all at once: the first says who takes what, by their roles, and does its part; the next ones read that and do only what was left to them, or say in a sentence it's covered. Nobody does the same thing twice, and naming each other there doesn't call them a second time.
- **Agents ask a channel for help.** An agent that doesn't know, or gets something outside its area, can ask one of its channels who can help, as a person would, with a new `pedir_ajuda` tool. The question opens a thread there, the channel's router picks who answers (up to two), and they answer in the thread, where you can join in. What they say comes back to the agent that asked, which goes on with your request; if no one there can help, it hears that and tells you what's missing. Its reply shows **Theo in #dados** with a link to the thread.
- **An agent does one thing at a time.** Work that comes for an agent while it's busy (a mention from another agent, a task, a question in a channel, another message) no longer starts a second reply alongside the first: it shows up at once as **Queued** and starts when the agent is done, in the order it came. Other agents keep working meanwhile.
- **Agents pass on what isn't theirs.** Every agent now sees what each colleague does (its role and the first line of its instructions), not only its role, and is told to hand over, without being asked, a request or part of one that's a colleague's area (a data table to whoever handles data, code to engineering), saying in a sentence who it went to and why, then deliver the answer; when it doesn't know whose it is, it asks a channel. In a busy channel, whoever answers does the same out in the open.
- **Agents' computers come set up.** **Settings › Agents › Agents' computer** takes a bash script every new Linux computer is set up with, so agents stop spending turns installing (and getting wrong) the same tools on each one. It runs once into a base image that every computer made after it starts from, in seconds; the agent is told what's already there. Ready-made, tested lines add the basics (jq, unzip, ssh, psql), GitHub CLI, GitLab CLI (glab), the Databricks CLI and the AWS CLI. A setup that fails says why, with its last lines, and the computer doesn't start half-done.
- **An agent can use your SSH, without your keys.** On an agent's page, **Tools › Computer › Use my machine's SSH** hands its Linux computer your SSH agent, so your keys sign for it but never leave your machine; your ~/.ssh config, known_hosts and public keys go along (never a private key), so your host names work. On Linux it uses your session's agent, on a Mac Docker Desktop's own forwarding; Docker on Windows can't hand it in, and the page says so. Off by default, per agent: everything it does over SSH goes out as you, and it's told so.

### Fixed

- **Claude replies finish about 2 seconds sooner, at times 10.** After each reply Claude Code made one more model call, a summary of the turn that Tucano never reads, and only then said it was done and exited. That call is now off for the Claude Code that Tucano runs, so a reply ends when its text does, and what waits on it (the next agent in line, a team's report) starts right away. Your own Claude Code in the terminal isn't touched.
- **Agents see what a connector returns, even when it's long.** A result over Claude Code's own cut (about 50 KB, like the comments of a big merge request) was saved to a file the agent can't read, so it called again and again and answered without the data. Tucano now cuts a result at 40 KB, counted in bytes so accents don't push it over, and tells the agent to ask again with pagination or a filter if it needs the rest.
- **An agent stops at once when its computer can't run.** With Docker off, out of reach or not installed, every command and file read failed, and the agent tried tool after tool, spending tokens to find out the same thing. Now the first call that finds Docker down ends the reply, which says what to do (start Docker, join the docker group, install it) and can be tried again. While Docker stays off, the next replies don't get the computer's tools at all: the agent is told it's down and says so in a sentence, answering what it can without it.
- **The same error three times ends a reply.** When different calls (another command, another file) keep getting the very same error, what's broken is around them, so the reply stops at the third and shows the error, instead of trying for minutes. A Docker that doesn't answer at all now counts as down too, like one that's off.
- **Agents keep to the thread they're answering.** A reply in a thread got the recent messages of every other thread in the conversation mixed in by time, under a heading saying they were all this thread, so agents answered old subjects again, repeated themselves and lost track of what was asked. Now the other subjects come first and apart, one block each (what opened it and how it ended), marked as dealt with elsewhere, and then this thread, whole, under its own heading.
- **Connectors stay connected.** A local connector whose process ended (a crash, or one that quits when idle) stayed **Disconnected** for good, and its tools went away from the agents, so nothing ever brought it back; and a remote one whose server forgot an idle session failed every call while still showing **Connected**. Now a connection that drops on its own comes back by itself, after a wait that grows from 2 seconds to 5 minutes, and a call on a forgotten session opens a new one and goes through. A connector that's only reconnecting keeps its tools; one that needs you (a refused token, a sign-in to finish) doesn't, and isn't retried.
- **Models behind a company gateway answer fast at low and medium effort.** Claude Code asks every call to think, which puts a model that isn't Anthropic's (DeepSeek through a gateway, say) in its slow reasoning mode, so each step took 10 seconds to a minute and the reasoning could even pass the output cap on a plain "oi". Now, on such models, Low and Medium effort turn that off and High and Max keep it; the agent's page says so under the effort. Anthropic's models are unchanged, and your own `CLAUDE_CODE_DISABLE_THINKING` in Claude Code's settings still wins.

### Changed

- **Messages in a row go together.** What you send while an agent is still on your last message no longer starts a reply of its own: it goes in that reply's thread, marked **Waiting**, and once the agent is done it answers everything that came in, in one reply, reading it as more of the same request. **Steer now** on a waiting message stops the agent and starts it again with it in hand, without redoing what's done. A message in another thread, or an answer to the agent's question, still gets its own reply.

## [0.2.10] - 2026-11-04

> **Em português:** chegaram as threads: cada resposta a uma mensagem, e o que ela dispara, fica na thread dela, que abre na lateral. Na conversa aparecem só as mensagens que abriram uma thread, com quem participou, quantas respostas e o que espera por você. E um "bom dia" pro grupo agora chama todos os agentes. Também dá pra ditar mensagens: clique no microfone, fale e clique de novo, e o texto cai no campo pra você revisar. Tudo roda no seu computador, sem internet, e o modelo baixa com um clique. Os canais podem ser arrastados e organizados em grupos que recolhem, e um caminho de arquivo na mensagem de um agente vira link. O token de um conector pode ser trocado sem remover o conector. Os erros agora dizem o que aconteceu e o que fazer. E uma leva de correções: os agentes no Gemini passam a ler as configurações do Tucano, o modelo reserva entra no limite de 5 horas do Claude Code, as rotinas mandam a resposta inteira pro Telegram e, no Windows, o Tucano não trava mais a atualização de outros apps. Obrigado à Rayanne, ao Gabriel, ao Alan, ao Cleiton e ao Kayo!

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

> **Em português:** o Tucano agora tem uma wiki: o que você e o seu time sabem, em páginas ligadas, que os agentes consultam antes de responder e citam. Um curador lê as conversas e os documentos que você traz (PDF, Word, planilha, link ou anotação) e escreve nas páginas, citando de onde veio; mudar uma página que já existe espera a sua aprovação, se você quiser. A wiki é uma pasta de Markdown que o Obsidian abre, aparece como um mapa que você arrasta, e uma revisão aponta o que não bate, o que ficou velho e o que está repetido. Já tem um cofre do Obsidian? Ele entra como está, com pastas, links e anexos. E dá pra trazer agentes do OpenBot e do Grok Bot.

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
