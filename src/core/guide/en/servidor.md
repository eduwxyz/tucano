# Tucano on a server
> Running Tucano on a server of your own (a VPS or a machine at home) and using it through the browser: installing, reaching it, keeping it running and what changes.

On a server the routines keep running when your computer sleeps, and you use Tucano from the browser, on any computer or phone. Nothing goes through a Tucano service: the server is yours. It is new and experimental.

## What it needs
- Linux (x64 or ARM64), with 2 GB of RAM or more, and Node.js 24 or newer.
- At least one harness installed and signed in **on the server**, with the user that runs Tucano (over SSH).
- Optional: Docker Engine (the agents' Linux computers) and Chromium or Chrome (the agents' browser).

## Installing
As the user that will run Tucano (not root): clone the repository, `npm ci`, `npm run build` and `npm run server`. It prints the address with a token (`http://127.0.0.1:7337/?token=…`). Open that link once: the token goes into the browser and a cookie keeps it. To sign every browser out, delete the `server-token` file in the data folder and restart.

## Reaching it
By default it only listens on the server itself, because whoever has the token controls the agents. Ways in:
- An SSH tunnel (`ssh -L 7337:127.0.0.1:7337 …`), the simplest.
- Tailscale or another private network, with `TUCANO_HOST` set to its address.
- A reverse proxy with HTTPS (Caddy, nginx) on a domain of yours.

Never expose port 7337 on a public address without HTTPS.

## Keeping it running
As a systemd service under your user. To update: `git pull && npm ci && npm run build`, then restart the service. There is no automatic update.

Variables: `TUCANO_DATA` (the data folder, `~/.tucano-server` by default), `TUCANO_HOST`, `TUCANO_PORT` (7337) and `TUCANO_TOKEN`. Behind an outbound proxy, `HTTPS_PROXY` (and `NO_PROXY`): the connectors go through it. Tucano trusts the system's root certificates besides Node's.

## What changes from the app
- Notifications: in the **Tucano app on the computer** connected to it (**Settings › Servers**), like the app's own, while that app is open, and in the iPhone app. In the browser, only over HTTPS (a proxy with HTTPS, or `tailscale serve`): over `http://` on the Tailscale address or the home network the browser shows none. Telegram (**Settings › Phone**) notifies in any case. **Settings › General › Notifications** › **Send one** tests it.
- A connector with OAuth: the authorization opens in your browser; when it ends, you paste the address where the page stopped.
- Choosing a folder asks for its path on the server.
- The wiki can use your Obsidian vault kept in a git repository: **Wiki settings** › **Sync with git**. See **wiki-git**.
- Computer apps do not exist on a server (there is no screen).
- One Tucano per data folder: do not run the app and the server on the same folder at the same time.
- A server is one workspace only (the one in the data folder).
