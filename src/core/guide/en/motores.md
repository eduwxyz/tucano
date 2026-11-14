# Harnesses and accounts
> Where the agents run: the harnesses, how to sign in, extra accounts, the company gateway and the Jev router.

The agents have no model of their own: every reply runs in a program you already have on the computer, called a harness. Tucano only reads each one's configuration; it never sees or keeps your passwords and keys.

## The harnesses
Claude Code, Codex, OpenCode, Pi, Antigravity CLI, Cursor CLI, Grok, Cline CLI and Hermes. Each one appears in **Settings › Models**, in the **Harnesses** card, with its state: **Ready**, **Not signed in** or **Not installed**.

- **Install**: opens a terminal that installs it for you. Some need Node.js first.
- **Sign in**: opens a terminal with the login command (for example `claude auth login`, `codex login`, `grok login`). When the login ends, the app notices by itself.
- **Test** / **Send a test**: checks that it is working.
- **Check again**: looks again after installing or signing in.

**Cline CLI** (`npm install -g cline`) signs in through a login of Tucano's own: **Sign in** opens `cline auth`, where you pick the Cline account (in the browser) or a provider with your key; your `~/.cline` is not touched. Each reply runs in a folder of its own, without your Cline rules, skills, hooks, plugins and MCP servers, and with Cline's own file and shell tools turned off: the agent only uses Tucano's tools (and the web, if it has it). The model list shows the last one of each provider you signed in to; another goes in **Other model…** as `<provider>/<model>`, for example `cline/anthropic/claude-sonnet-4.5`. Images do not go to Cline.

Each harness can run in three ways, as you configured it: on the **plan** (the Claude, ChatGPT etc. login, with no charge per use), by **API key** (charged per token) or through the company **gateway** (the proxy in Claude Code's `settings.json` or in Codex's `config.toml`). Through the gateway the agents use the same one, and telemetry is off.

## Each agent's model
On the agent's page, under **Where it runs and model**, you pick the harness and the model from its list. If the model is not there, use **Other model…** and type the exact name. You can have a **Reserve model**, used when the main one hits the subscription's limit.

## Extra accounts
For Claude Code and Codex you can have more than one login (e.g. "Work"). In **Settings › Models** › **Accounts**, **Add and sign in**. Each agent picks its account under **Account**. An account that has not signed in yet leaves the agent not answering until you sign in to it.

## The router
In **Settings › Models** › **Router**, the small model that reads the conversation and decides who answers in the channels. Prefer a fast one. One option is Jev, from TypeSafe: it decides in under 1 second, but sends the channel's last 10 messages to TypeSafe and needs the **TypeSafe key**. If it fails, Haiku decides.

## When it goes wrong
- The agent does not answer and the harness says **Not signed in**: click **Sign in** and do the login in the terminal.
- No terminal opened: the app shows the command to paste into your terminal.
- Subscription at its limit: the agent stops with the limit message; use the reserve model or wait for the window to reset (see **limites**).
