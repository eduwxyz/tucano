# Plan: VPS + local machines ("local node")

**Owner's goal (2026-11-11):** one Tucano, synced across Windows, Mac and phone, on the VPS (vsn-vps). Agents can't lose any local operation:

- creative apps (Premiere, Figma desktop, Adobe)
- terminal and repos (git, builds, Jaques OS)
- files and folders
- logged-in browser

That holds on **both machines**. With a machine off, the agent **does what it can** and says what was left pending. Autonomy and approvals **stay as they are today**.

## The idea in one line

Each computer becomes a **connector** of the VPS's Tucano: the "Windows do Jaques" node and the "Mac do Jaques" node. The local app exposes the machine's capabilities as MCP tools on a private address (Tailscale). The VPS calls them like any connector, with the classes, approvals, steps and logos that already exist.

```
 Phone / Mac / Windows ──(sync UI)──▶  Tucano on the VPS (core, database, agents, routines)
                                            │  connector "Windows do Jaques"   (Tailscale, key)
                                            │  connector "Mac do Jaques"
                                            ▼
                          Local Tucano app (node) ─ terminal · lent folders · apps · browser
                                                 └ proxy of the local connectors (premiere-pro, figma-desktop…)
```

Why this is cheaper and safer than a "remote core":

- It reuses everything the VPS already does with connectors: tool classes (read/write/sensitive), approvals in the chat, "always allow", grants per agent, steps with progress, error messages.
- Machine off = connector unreachable. The core already reports "the connector isn't connected", and the agent moves on with what it can, which is the "do what it can" behavior. Missing piece: the agent's prompt should name the nodes and what each one does.
- Nothing new is open on the internet: the node listens only on the Tailscale network, with a key per node.

## What the node exposes (MCP tools)

| Family | Tools | Comes from (already exists) | Class |
|---|---|---|---|
| Terminal | `rodar(comando, pasta)` | `computer.ts` (the "mac" kind: runs as the user) | via `shellActions` (read → write → sensitive), as today |
| Files | `ler`, `escrever`, `listar`, `buscar` in **lent folders** | `local-paths.ts` and lent folders | read / write |
| Apps | `app_ver`, `app_clicar`, `app_escrever`, `app_tecla` | `apps.ts` (agent-desktop) | as today |
| Browser | `navegador_*` | `browser.ts` (Chrome with the node's own profile, logins kept) | as today |
| Local connectors | the tools of `premiere-pro`, `figma-desktop`, Jaques OS… | `ConnectorManager` on the local app | each connector's own class |

"Logged-in browser": it's the node's Chrome profile. You sign in to sites there once, through Take over, and the logins stay.

## Pieces to build

1. **Node server in the local app** (core): an MCP HTTP server built on `@modelcontextprotocol/sdk`, already a dependency. It's on/off under Settings › This computer as a node. It listens on the Tailscale address only, with a bearer key per VPS. It lists the tools above and runs each one with the existing modules.
2. **Pairing:** a "Connect this computer to the server" button generates the key and registers the node on the VPS as a remote connector (URL `https://<machine>.<tailnet>.ts.net/node`, auth token). It reuses the pairing flow from Settings › Servers.
3. **On the VPS:** a node connector carries a `node` kind and a computer logo. In the agent's page, under "Where it works", you pick which nodes it uses. The prompt says "you have the Windows and Mac computers; if one is off, do what you can and say what's left".
4. **Local connectors through the node:** the node proxies the local app's connectors (premiere-pro, figma-desktop…) as its own tools, prefixed per connector. This avoids reconfiguring them on the VPS.
5. **Offline:** a node call while the machine is off returns a clear error ("the Windows computer is off"), the step shows it, and the agent goes on. Phase 2: an optional queue ("try again when it comes online").

## Status (2026-11-12)

- **Phase 0:** the server runs on the VPS (systemd `tucano`, 127.0.0.1:7337, data migrated, Claude Code installed for the `tucano` user). Still the owner's: install Tailscale, sign Claude Code in, connect the apps.
- **Phases 1–3: done.** `core/node-server.ts` exposes the terminal and files, the app's connected connectors (`<connector>__<tool>`, in the class set on this computer), the browser and the lent apps. A risky click or key goes through `node_approved`, which the server classes as sensitive.
- **Phase 4: done as chosen ("do what it can").** A call to a node that's off tells the agent to go on without it and say what's left. Picking which agents use each computer is the grant on the node's connector. There's no queue: the owner picked "do what it can".

## Phases

| Phase | Delivers | Effort |
|---|---|---|
| 0 | Tucano server on the VPS + Windows data migrated + apps connected (sync) | hours (needs SSH permission) |
| 1 | Node with **terminal + files** + pairing + offline | ~1–2 days |
| 2 | **Local connectors** through the node (Premiere, Figma desktop, Jaques OS) | ~1 day |
| 3 | **Apps and browser** through the node | ~1–2 days |
| 4 | Queue for when the machine is off; "where it works" choice per agent | ~1 day |

Each phase ships with tests and is used for real before the next one.

## Risks and decisions

- **Security:** the VPS's agents run commands on your computer. Mitigations: Tailscale only (never the internet), a key per node that can be revoked, the same autonomy and approvals as today, a log of every command in the steps.
- **Two machines with the same tool:** each node has its own name, and the agent picks by description ("Premiere is on Windows").
- **Upstream:** this is a feature of the fork. It may go to eduwxyz/tucano later, as a PR, if it makes sense.
- **The first `claude` on the VPS** has to be signed in by you once (Settings › Models › Sign in).
