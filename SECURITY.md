# Security

Tucano runs AI agents that can read your tools, run commands and click in a browser, so its permission model matters. If you find a way around it, please tell us privately.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/eduwxyz/tucano/security/advisories/new). Please don't open a public issue. Include what an attacker could do, the steps to reproduce and the version you tested. You'll get an answer within a few days.

Especially interesting:

- an agent using a tool it wasn't granted, or a write tool with read-only access;
- a sensitive action running without its approval, or an approval that runs something other than what was shown;
- an agent reaching files outside its computer and the folders lent to it;
- content from a web page, an issue or an email making an agent act on its own (prompt injection that crosses a permission boundary);
- secrets (tokens, connector logins) leaving the vault-encrypted store (macOS Keychain, Linux keyring) or reaching a model.

## How Tucano keeps agents in bounds

- Each reply runs the harness CLI isolated from your personal configuration, with no built-in tools. Its only tools come from Tucano's local MCP gateway, through a secret per-turn URL that lists just that agent's tools; any other call is refused.
- Write actions that matter (merge, publish, send, delete) become an approval tied to the exact call and arguments. Approving runs exactly that call, after checking the grant again.
- Connector secrets are encrypted with a key in the macOS Keychain (on Linux, the system keyring: GNOME Keyring or KWallet) before they reach the database. Without a keyring, Tucano refuses to store them.
- An agent's computer is a Docker container with only its own folder and the folders you lend it, or, if you choose so, your own computer.
- Everything stays on your computer: conversations, memory, logins. There is no Tucano server.
