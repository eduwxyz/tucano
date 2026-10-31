# Changelog

What changed in each version of Tucano. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org) (while in 0.x, a minor version may change things). Each section is also the release's notes on GitHub, which is what the app's "What's new" link opens.

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

[0.2.2]: https://github.com/eduwxyz/tucano/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/eduwxyz/tucano/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/eduwxyz/tucano/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/eduwxyz/tucano/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/eduwxyz/tucano/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/eduwxyz/tucano/releases/tag/v0.1.0
