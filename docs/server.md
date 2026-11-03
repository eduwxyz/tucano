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

## Before the server release is published

The one-command URL below works once a release includes the new server assets. While reviewing
this PR, use the Server workflow's `tucano-server` artifact, or build the package yourself:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build
sh scripts/pack-server.sh dist-server
TUCANO_TARBALL="$PWD/dist-server/tucano-server.tar.gz" sh install-server.sh --host user@your-vps
```

Run the installer on the Linux server as its service user. Copy the script, archive and matching
`.sha256` file there first if building on another machine. Do not point the production installer at
an unreviewed archive.

## Install with one command

As the user that will run Tucano, not root. On a new VPS, make that user once (`adduser tucano && loginctl enable-linger tucano`), then sign in over SSH as `tucano`:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install-server.sh | sh -s -- --label "My Mac"
```

It needs `curl`, `tar`, a SHA-256 utility (`sha256sum` or `shasum`), and a working systemd user session. Download time depends on your connection. The script:

- downloads the server (one package for x64 and ARM64) and checks it against its SHA-256 checksum before it unpacks anything;
- uses the system's Node 24 if there is one, and otherwise downloads one of its own, checked against nodejs.org's checksums (nothing is installed system-wide);
- keeps the server running as a systemd **user service**: it restarts if it dies and starts at boot. It listens on `127.0.0.1:7337` only, so nothing is exposed until you choose how (see [Reaching it](#reaching-it));
- adds the `tucano-server` command to `~/.local/bin` (`pair`, `devices`, `revoke`; see [pairing.md](pairing.md));
- prints a pairing code, the link that pairs the Mac app, and the `ssh` command for a browser.

The link names the address your computer reaches the server at. Run over SSH, the script takes it from your login; to say it yourself, use `--host vps.example.com` (or `--host vps.example.com:2222`, or `--host user@vps.example.com`). The service journal holds neither a token nor a pairing code. Treat the code and `tucano://pair` link printed in your terminal as temporary secrets: each works once, for five minutes.

Run the same command again to **update**: the data in `~/.tucano-server` stays, paired devices keep working, and the current and previous releases are kept. A failed service restart restores the previous program, command and unit and reports a failure. This is a binary rollback, not a database backup: back up the data folder before upgrading. `sh -s -- --uninstall` removes the service and the program (the data stays; add `--purge` to delete it too). `sh -s -- --help` lists the rest: `--port`, `--no-service`, `--pair` (a new code on an update).

### Direct pairing without SSH

If you already have HTTPS forwarding to `127.0.0.1:7337` (Caddy, nginx or Tailscale Serve), install and generate the direct Mac/browser link with:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install-server.sh | sh -s -- --label "My Mac" --url https://tucano.example.com
```

`--url` only chooses the address in the pairing link. It does not create a proxy, open a firewall port, configure DNS, or change the loopback bind address. Configure and verify that route first. For an existing install, issue a new link with `tucano-server pair --label "My Mac" --url https://tucano.example.com`, or rerun the installer with `--pair --url …`. `--host` and `--url` are alternatives, not options to combine.

For private Tailscale HTTP access, use the machine's Tailscale IP (for example `http://100.64.0.2:7337`), set `TUCANO_HOST` in a persistent service override as described below, and connect the Mac to that tailnet. Prefer Tailscale Serve HTTPS if available. Public HTTP URLs are not accepted by the Mac pairing flow.

In the Mac app, open **Settings → Servers → Add**, paste the `tucano://pair` link, and confirm. The app exchanges the code for a separate device token. SSH mode uses your Mac's existing SSH access; direct mode uses the URL. To check or remove access, run `tucano-server devices` or `tucano-server revoke <id>`. See [pairing.md](pairing.md) for keychain storage, expiration and reconnect behavior.

### Optional computer on the VPS

Each VPS can optionally provide a private Linux virtual desktop for its agents. The default remains a headless server listening only on loopback. Use separate Linux users/VPSs, data folders and device pairings for personal and work environments; enabling a desktop on one server does not enable it on another.

An administrator must first install the desktop prerequisites on that VPS. Example for Debian/Ubuntu, run manually after reviewing it:

```bash
sudo apt install xvfb xauth openbox dbus-x11 x11-utils util-linux bash at-spi2-core
npm install --global --prefix "$HOME/.local" agent-desktop@1.0.2
```

The npm command runs as the non-root Tucano user and needs Node/npm already installed. The installer never runs these commands or elevates privileges for you. Then add `--desktop` to the normal install command, or rerun it with `--desktop --no-pair` on an existing server. It checks prerequisites before replacing a working service and uses a packaged launcher to start the isolated display. Subsequent updates remember the option. Pass `--no-desktop` to return to the headless service.

No VNC/RDP port is exposed by this option. It is a virtual display under the server's Linux account, not a security sandbox: agents can access that user's files and credentials, subject to Tucano's approval controls. Keep work and personal accounts isolated. See [VPS desktop setup and limits](vps-desktop.md) for verification, dependencies and operation.

### Troubleshooting the service

Run these as the same user who installed Tucano:

```bash
systemctl --user status tucano.service
journalctl --user -u tucano.service -n 50 --no-pager
loginctl show-user "$USER" -p Linger
```

If there is no user session, install `dbus-user-session` on Debian/Ubuntu and log in over SSH again. An administrator can run `loginctl enable-linger tucano` so this user's service survives logout and starts at boot. `sudo -u` alone may not create a user session. The installer clears another user's inherited XDG/session-bus settings when invoked through a cross-user `sudo`; an ordinary SSH login is the simplest setup.

If you deliberately customize service environment settings, use `systemctl --user edit tucano.service`. For example, to listen on your own Tailscale IP:

```ini
[Service]
Environment="TUCANO_HOST=100.64.0.2"
```

Then run `systemctl --user daemon-reload && systemctl --user restart tucano.service`. Replace the example with the server's actual address. Drop-in overrides survive installer updates. Do not set a public bind address without a secure access plan.

For a manual binary rollback, inspect `ls ~/.local/share/tucano-server/versions`, point `current` at the retained release, and restart the service:

```bash
cd ~/.local/share/tucano-server
ln -sfn versions/<previous-release-directory> current
systemctl --user restart tucano.service
```

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

**Installer users:** the user service is already configured. Use `systemctl --user restart tucano.service`; no system-wide unit is needed.

**Source installs only:** run Tucano as a systemd service, under your own user. Save this as `/etc/systemd/system/tucano.service` and change the user and the path:

```ini
[Unit]
Description=Tucano
After=network-online.target

[Service]
User=you
WorkingDirectory=/home/you/tucano
ExecStart=/usr/bin/npm run server
Restart=on-failure
RestartSec=3
UMask=0077
StandardOutput=null
Environment=TUCANO_PORT=7337

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable --now tucano`. The logs are in `journalctl -u tucano`. Standard output is suppressed so startup pairing codes do not enter the journal. Generate a code explicitly in your SSH terminal with `node out/main/server.js pair --label "My Mac"`.

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

## Installer regression checks

`node --test scripts/installer-test.mjs` runs without a build, network, root privileges or a real systemd session. It tests fresh installs, inherited sudo XDG settings, custom paths, updates, same-version reinstall, rollback on restart failure, checksums, unsafe archives/paths, SSH/direct link forwarding, uninstall/purge behavior, and optional desktop prerequisite checks, quoting, preference preservation and disabling. Service/network commands are mocks, so this is not evidence of a live VPS or Mac connection.

The Server GitHub Actions job additionally builds the real package and tests a user service on Ubuntu: startup, pairing, process restart, update with the retained port, and uninstall with data preservation. The full app/server connection suite lives separately in `scripts/server-e2e.mjs`.
