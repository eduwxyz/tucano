**English** · [Português](local-node.pt-BR.md)

# Your computer as a node of a Tucano server

When Tucano runs on a server ([Tucano on a server](server.md)), its agents lose what only exists on your computer: its terminal, its files, its browser with your logins, its apps and its local connectors. A **node** gives these back. The desktop app on your computer becomes a connector of the server's Tucano, reached over your private [Tailscale](https://tailscale.com) network with a key of its own. The server's agents use your computer through it, with the same approvals as everywhere else.

Status: **new and experimental.** For servers you run yourself. Tested with a node and a server on the same machine; a real VPS over Tailscale end to end, real browser and app clicks through the node, and Windows haven't been tested yet.

Thanks to [@pedrojaques99](https://github.com/pedrojaques99), who designed and built the node.

## Read this first

**Whoever has the node's key can run commands on your computer, as you.** The key lives on your server. Turn the node on only for a server you control, and change the key (Settings › Servers › Change) if you think it leaked.

**Use `tailscale serve`, never `tailscale funnel`.** `serve` makes the node reachable only from devices on your tailnet. `funnel` opens it to the whole internet.

## What the server gets

| Tool | What it does | How it's judged on the server |
|---|---|---|
| `node_bash` | Runs a command in a terminal on your computer | Like a local command: read runs alone, push, delete and publish follow each agent's rules. Never lower than "write". |
| `node_read_file`, `node_list` | Read and list files | **Only inside the folders you lend** (see below) |
| `node_write_file`, `node_edit_file` | Write and edit files | Only inside the folders you lend, and never into `.git`, `.husky`, `.envrc`, shell profiles or LaunchAgents. Never lower than "write". |
| `node_approved` | A risky click or key in the browser or an app | Judged as a browser or apps action, like here: "Never" refuses, "Does it alone" runs, otherwise it asks. Never "always allowed". |
| `<connector>__<tool>` | Your computer's connected connectors (Figma desktop, Premiere…) | At least the class you set here; a "high risk" mark set here stays on |

The class floors are enforced by the server's core, not only by the screen: lowering `node_bash` to "read" on the connector card doesn't make commands skip approval.

## Set it up

You need Tailscale, signed in to the same account, on your computer and on the server.

**On your computer** (desktop app):

1. Settings › Servers › **This computer as a node**: turn it on. It listens only on `127.0.0.1:7441`.
2. With Tailscale open, in a terminal:
   ```bash
   tailscale serve --bg 7441
   tailscale serve status   # shows https://<this-computer>.<your-tailnet>.ts.net
   ```
3. Copy the **Key** from the card.
4. **Lend folders** (below). With none, the server's agents can't read or write any file on this computer.
5. If the agents now live on the server, **pause this computer** (the card offers it) so nothing answers twice. The node keeps working while paused.

**On the server's Tucano:**

1. Connectors › Add custom › **Remote**, address `https://<this-computer>.<your-tailnet>.ts.net/mcp`, authentication **Token**, paste the key.
2. Under Tools, give access to the agents that will use this computer.

When the computer is off or asleep, the connector is unreachable: the agent goes on without it and says what's left to do.

## Lent folders

The file tools reach only the folders you lend on the card, plus the node's own working folder. Paths are resolved for real, so `..` and symlinks don't escape. Some folders can't be lent, and the card says which and why:

- `/`, your whole home folder, or anything outside it
- `~/Library`, `AppData` and any folder starting with a dot (`.ssh`, `.aws`, `.config`…)
- Tucano's own data

`node_bash` is still a real terminal: a command can read what you can read. That's why it goes through the command rules and asks on Careful, instead of running silently like a read.

## What the server ran here

The card's **What the server ran here** lists every call the server made through the node, newest first: time, tool, a short summary (command, path or arguments, with secrets masked), and whether it worked. It's kept on your computer (`<Tucano data>/node/log.jsonl`, the last 2000 calls) and only you see it. Press **Refresh** to update it.

## Limits

- Approvals happen on the server. The node trusts whoever has the key and logs what it runs, but doesn't refuse on its own.
- All of the server's agents share one identity on the node: one working folder, one Chrome profile, one set of logins.
- Not for Tucano Pro yet.
