---
slug: how-to-install-tucano-on-mac
titulo: How do I install Tucano on a Mac?
descricao: Download the .dmg, drag Tucano into Applications and follow the first-run setup. Works on Macs with Apple silicon or Intel.
atualizado: 2026-11-15
grupo: Getting started
ordem: 1
howto: sim
faq:
  - pergunta: Does Tucano work on an Intel Mac?
    resposta: Yes. On Apple silicon, use tucano-mac-arm64.dmg; on an Intel Mac, tucano-mac-x64.dmg. Tucano is tested on macOS 26 with Apple silicon.
  - pergunta: Do I need an API key to use Tucano?
    resposta: No. Agents use the Claude Code, Codex, Cursor, Grok, Cline, Hermes, OpenCode or Pi already installed on your Mac, with the login you already have. Tucano never sees your password.
  - pergunta: Does macOS show a warning when I open Tucano?
    resposta: No. The app is signed and notarized by Apple, so it opens with no warning.
  - pergunta: How do I update Tucano?
    resposta: It updates itself. It downloads the new version in the background and shows Restart in the sidebar when it's ready; if you don't click it, the update goes in the next time you quit the app.
---
To install Tucano on a Mac, first install a harness, such as Claude Code, and sign in to it. Then download Tucano's `.dmg`, open it and drag the app into **Applications**. On the first run, Tucano walks you through the setup and ends with your first agent already working in a channel.

## What you need

- A Mac with Apple silicon or Intel. Tucano is tested on macOS 26, Apple silicon.
- At least one harness, installed and signed in: Claude Code, Codex, Cursor CLI, Grok, Cline, Hermes, OpenCode or Pi.
- Optional: [Docker Desktop](https://www.docker.com/products/docker-desktop/), to give agents an isolated Linux computer, and Google Chrome for their browser. Without Chrome, the app uses the built-in browser.

## 1. Install a harness

The harness is the program agents think with. Claude Code is the quickest to install. In Terminal:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

Prefer Codex? Run `npm install -g @openai/codex`. You sign in to it from inside Tucano.

## 2. Download and install Tucano

Download [tucano-mac-arm64.dmg](https://github.com/eduwxyz/tucano/releases/latest/download/tucano-mac-arm64.dmg), open it and drag Tucano into **Applications**. On an Intel Mac, take [tucano-mac-x64.dmg](https://github.com/eduwxyz/tucano/releases/latest/download/tucano-mac-x64.dmg) instead.

The app is signed and notarized by Apple, so it opens with no warning.

## 3. Go through the first-run setup

Pick a language (English or Portuguese) on the first screen. Then, in a few steps: your name; which harnesses agents may use, each with a **Test now** button; the models that route channels and keep memory; what every agent should know about you; your tools and skills (optional); and your first agent, from a template or from scratch. It ends in a `#general` channel with your agent already working.

The first time Tucano saves a connector password, macOS asks whether it may use the **Keychain**: click **Always Allow**.

## Install from Terminal

If you prefer, one command downloads the latest release, puts Tucano in **Applications** and opens it:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install.sh | sh
```

## Update

From version 0.1.2 on, Tucano updates itself. It downloads the new version in the background and shows **Restart** in the sidebar when it's ready. If you don't restart, it goes in the next time you quit the app.

## Uninstall

1. Quit Tucano (⌘Q) and delete `/Applications/Tucano.app`.
2. To delete your data too, run `rm -rf ~/Library/Application\ Support/Tucano` in Terminal.
3. If you used the agents' Linux computer, delete the `tucano-*` containers in Docker Desktop.
4. If you want, delete the **Tucano Safe Storage** item in Keychain Access.
