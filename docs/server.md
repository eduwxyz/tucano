# Tucano on a server

Tucano can run on a server you own, such as a VPS or a machine at home. On a server, routines keep running when your computer sleeps, and you use Tucano from a browser, on any computer or phone. The server runs Tucano's core on plain Node and serves the app's own screens to the browser. Nothing goes through a Tucano service: the server is yours, and so are the data and the logins on it.

Status: **new and experimental.** The core, the screens and the agents work in a browser, tested on Linux (Debian 12, Node 24) and macOS. A real agent turn on a server has only been tested with the test engine so far.

## What you need

| | |
|---|---|
| Linux, x64 or ARM64 | Any VPS with 2 GB of RAM or more |
| [Node.js](https://nodejs.org) 24+ | Tucano's database is Node's built-in SQLite |
| At least one harness, installed and signed in | Signed in **on the server**, as the user that runs Tucano (see below) |
| Optional: Docker Engine | For agents' isolated Linux computers |
| Optional: Chromium or Google Chrome | For agents' browsers (`apt install chromium`) |

## Install with one command

As the user that will run Tucano, not root. On a new VPS, make that user once (`adduser tucano && loginctl enable-linger tucano`), then sign in over SSH as `tucano`:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install-server.sh | sh -s -- --label "My Mac"
```

It needs `curl` and `tar` and nothing else, and it takes about a minute. The script:

- downloads the server (one package for x64 and ARM64) and checks it against its SHA-256 checksum before it unpacks anything;
- uses the system's Node 24 if there is one, and otherwise downloads one of its own, checked against nodejs.org's checksums (nothing is installed system-wide);
- keeps the server running as a systemd **user service**: it restarts if it dies and starts at boot. It listens on `127.0.0.1:7337` only, so nothing is exposed until you choose how (see [Reaching it](#reaching-it));
- adds the `tucano-server` command to `~/.local/bin` (`pair`, `devices`, `revoke`; see [pairing.md](pairing.md));
- prints a pairing code, the link that pairs the Mac app, and the `ssh` command for a browser.

The link names the address your computer reaches the server at. Run over SSH, the script takes it from your login; to say it yourself, use `--host vps.example.com` (or `--host vps.example.com:2222`, or `--host user@vps.example.com`). The journal holds no token.

Run the same command again to **update**: the data in `~/.tucano-server` stays, paired devices keep working, and the last two versions are kept to go back to. `sh -s -- --uninstall` removes the service and the program (the data stays; add `--purge` to delete it too). `sh -s -- --help` lists the rest: `--port`, `--no-service`, `--pair` (a new code on an update).

The harness (Claude Code, Codex…) is installed and signed in on the server as that user; see below.

## Install from source

As the user that will run Tucano (not root):

```bash
git clone https://github.com/eduwxyz/tucano.git
cd tucano
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # the server doesn't need Electron itself
npm run build
npm run server
```

On the first start, with nobody paired yet, it prints a link with a one-time code:

```
Tucano server: http://127.0.0.1:7337/
Nobody is paired yet. This browser can sign in once, in the next 5 minutes: http://127.0.0.1:7337/?pair=K7QM-2XPD-9TWH
```

Open that link once. The browser trades the code for a token of its own and a cookie keeps it signed in. For another device, make a new code on the server with `node out/main/server.js pair --label "My Mac"` (see [pairing.md](pairing.md): who is paired, revoking one device, and the Mac app).

The server doesn't print its own token, because a log is read by more people than the one who owns the server. It is in `~/.tucano-server/server-token`, for scripts (`Authorization: Bearer …`). To cut it, delete that file and restart Tucano, or set `TUCANO_TOKEN`.

### Signing the harnesses in

Sign each harness in on the server, in a terminal over SSH:

```bash
curl -fsSL https://claude.ai/install.sh | bash && claude auth login   # prints a link and asks for the code
npm install -g @openai/codex
```

Codex is signed in from Tucano's **Settings › Models**, like on a desktop. On a server, the **Sign in** button can't open a terminal, so it shows the command to run in your SSH session.

## Reaching it

By default the server only listens on the server itself (`127.0.0.1`), because anyone who has the token controls your agents. Pick one of these ways to reach it:

- **SSH tunnel**, the simplest: run `ssh -L 7337:127.0.0.1:7337 you@your-server`, then open the pairing link on your computer (or pair the Mac app: [pairing.md](pairing.md)).
- **Tailscale** (or another private network): set `TUCANO_HOST` to the server's Tailscale address, then open `http://<that address>:7337/?pair=<code>` (a code from `pair`) from any of your devices, including your phone.
- **A reverse proxy with HTTPS** (Caddy, nginx) on a domain of yours: keep Tucano on `127.0.0.1` and point the proxy at it. Turn off response buffering for `/events`, which is a live event stream. For example, with Caddy:

  ```
  tucano.example.com {
    reverse_proxy 127.0.0.1:7337 {
      flush_interval -1
    }
  }
  ```

Never expose port 7337 on a public address without HTTPS.

## Keeping it running

Run Tucano as a systemd service, under your own user. Save this as `/etc/systemd/system/tucano.service` and change the user and the path:

```ini
[Unit]
Description=Tucano
After=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/tucano
ExecStart=/usr/bin/npm run server
Restart=on-failure
Environment=TUCANO_PORT=7337

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now tucano`. The logs are in `journalctl -u tucano`. They hold no token; the first start prints a pairing code, good for 5 minutes and one device.

To update a source install, run `git pull && npm ci && npm run build && sudo systemctl restart tucano`. (An install made with the script updates by running the script again.)

## Settings

| Variable | Default | |
|---|---|---|
| `TUCANO_DATA` | `~/.tucano-server` | Where everything is kept: database, memory, agents' files, the key and the token |
| `TUCANO_HOST` | `127.0.0.1` | The address to listen on |
| `TUCANO_PORT` | `7337` | |
| `TUCANO_TOKEN` | a random token, kept in `server-token` | Set it to use a token of your own |

## How it differs from the desktop app

- **Connectors that sign in with OAuth** (an **Authorize in the browser** button): Tucano opens the authorization page in your browser. When you allow access, the page ends on an address starting with `http://127.0.0.1` that doesn't load, because that address is the server's own. Copy the whole address from the address bar and paste it into Tucano.
- **Secrets** (connector keys, Telegram, GitHub) are encrypted with AES-256-GCM. The key is in `server.key` in the data folder, and only your user can read that file. A desktop app keeps that key in the system's keychain instead. Back the key up together with the data folder: the secrets can't be read without it.
- **Notifications:** connect Telegram (**Settings › Phone and GitHub**) to get approvals, questions and results on your phone. The browser doesn't pop up notifications.
- **Agents' browsers** need Chromium or Chrome on the server, and run without a window. **Take over** doesn't open a window there: the live picture of the browser in the panel becomes the browser. Click on it, type, paste and scroll, then click **Hand back**. This is how you sign in to a site for an agent.
- **Pages agents serve** (a dashboard, an API) listen on the server's own `127.0.0.1`. Agents take their screenshots with the server's Chrome. When Tucano listens on a private address (Tailscale or a home network), it also passes each running page through on the same port at that address, so the preview panel and **Open** work from your computer. That doesn't happen on a public address, because those pages have no token. Over an SSH tunnel, forward the page's port too (`-L 5173:127.0.0.1:5173`).
- **Choosing a folder** asks for its path on the server, since the browser can't browse the server's disk.
- **No self-update.** Update by running the install script again, or with `git pull` (see above).
- **One Tucano per data folder.** Don't run the desktop app and the server on the same data folder at the same time.
