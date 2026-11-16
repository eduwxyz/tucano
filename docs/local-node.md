**English** · [Português](local-node.pt-BR.md)

# Your computer lent to a Tucano on a server

When Tucano runs on a server ([Tucano on a server](server.md)) or on Tucano Pro, its agents lose what only exists on your computer: the terminal, your projects, the browser with your sign-ins, your apps and local connectors. Lending your computer gives that back: the server's agents use your computer as a connector, under the same approvals as always.

Thanks to [@pedrojaques99](https://github.com/pedrojaques99), who designed and built the node.

## Turning it on

1. In the desktop app, connect the server in **Settings › Servers** (with the link it gives you), if you haven't yet.
2. Under the server, turn on **Let this server use this computer**.
3. In **What this computer lends**, lend your projects' folders.
4. In the server's Tucano, under **Connectors**, your computer shows up (e.g. "MacBook Pro de Eduardo"). Under **Tools**, give access to the agents that will use it.

That's it. No port to open, no network to set up, no key to copy: the app calls the server, with the same access it already uses to open the server in its window. It works from any network (home, office, mobile) and through any router.

The computer is available while the app is open. If you quit the app, the computer sleeps or the network drops, the connector shows as disconnected on the server, and the agent goes on without it and says what's left. When the computer is back, the app calls again by itself.

## Only for you

On a server with several people, your computer is yours. An agent reaches your computer only when it works for you: in a conversation of yours, a routine of yours, or when you asked in a channel. When someone else asks the same agent for something, it doesn't see your computer.

What waits for approval on your computer (a push, a risky click) only you allow: not an admin, not the Tucano's owner, not their Telegram. A team routine (a channel's) reaches no one's computer, and a lent computer can't be a routine's trigger ("when something new shows up").

On the server, someone else's computer shows with their name (e.g. "iMac · computador de Maria"). Each person lends up to 5 computers; a sixth replaces their oldest one that isn't connected.

## What the server gets

| Tool | What it does | How the server judges it |
|---|---|---|
| `node_bash` | Runs a command in a terminal on your computer | Like a local command: reading runs on its own; push, delete and publish follow each agent's rules. Never below "write". |
| `node_read_file`, `node_list` | Reads and lists files | **Only inside the folders you lend** |
| `node_write_file`, `node_edit_file` | Writes and edits files | Only inside lent folders, and never in `.git`, `.husky`, `.envrc`, shell profiles or LaunchAgents. Never below "write". |
| `node_approved` | A risky click or key in the browser or an app | Judged as a browser or apps action: "Never" refuses, "Does it alone" runs, otherwise it asks. Never "always allowed". |
| `<connector>__<tool>` | The connectors turned on on your computer (Figma desktop, Premiere…) | At least the class you gave it here; a "high risk" mark set here stays on |

These are the same locks as an agent working on this computer. The terminal is a real terminal: a command reaches what you reach, and goes through the same command rules. The class floors are enforced by the server's core, not only by the screen: setting `node_bash` to "read" on the connector card doesn't let commands skip approval.

## Lent folders

The file tools only reach the folders you lend, plus the node's own working folder. Paths are really resolved, so `..` and symlinks don't escape. Some folders can't be lent, and the screen says which and why:

- `/`, your whole home folder, or anything outside it
- `~/Library`, `AppData` and any folder starting with a dot (`.ssh`, `.aws`, `.config`…)
- Tucano's own data

## What the server ran here

The **What the server ran here** list shows each call the server made on your computer, newest first: time, tool, a short summary (command, path or arguments, with secrets masked; typed text shows only as its length) and whether it worked. It stays on your computer (`<Tucano data>/node/log.jsonl`, the last 2000 calls) and only you see it.

## So nothing runs twice

If your agents now live on the server, pause this computer (the screen offers it). The agents here stop answering and running routines, and the computer stays lent.

## For whoever runs the server

- The app calls `<server address>/node/link`, a live stream like the pages' `/events`, and answers with POSTs to the same address. Caddy needs nothing. With nginx, turn off response buffering on that path as for `/events` (`proxy_buffering off`), or honor the `X-Accel-Buffering` header Tucano already sends.
- Each link signs in with a device's key (the one the app got when it connected the server). Removing the person in **People**, or that device's key, cuts their computer off at once.
- The app never follows a redirect: the key and what the computer answers go only to the address the person connected. Connecting the same server again, with another link, turns lending off until the person turns it on again.
- The server can't reach the computer on its own: only the app opens the line, and only to servers it's turned on for.

## Limits

- Approvals happen on the server. The computer follows the server the person lent it to, and logs everything it runs.
- All of the server's agents share one identity on the computer: one working folder, one Chrome profile, the same sign-ins.
- Only the app's main workspace lends the computer.
