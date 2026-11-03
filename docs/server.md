# Tucano on a server

Tucano can run on a server you own, such as a VPS or a machine at home. On a server, routines keep running when your computer sleeps. Connect from the Tucano desktop app or from a browser on any computer or phone. The server runs Tucano's core on plain Node and serves the app's own screens to the browser. Nothing goes through a Tucano-hosted service: the server is yours, and so are the data and the logins on it.

Status: **new and experimental.** The core, the screens and the agents work in a browser, tested on Linux (Debian 12, Node 24) and macOS. A real agent turn on a server has only been tested with the test engine so far.

### Local, Personal and Work

Keep **This computer** for local work, and pair a separate VPS as **Personal** and another as **Work** using the desktop app's top environment selector. Each VPS needs its own installation, Linux service user, data and harness sign-ins. Pairing does not move your local agents or credentials to a server, and switching environments does not merge their data. Start with SSH unless you already maintain an HTTPS route; a graphical Linux desktop is optional, not a pairing prerequisite.

## What you need

| | |
|---|---|
| Linux, x64 or ARM64 | Any VPS with 2 GB of RAM or more |
| [Node.js](https://nodejs.org) 24+ | Tucano's database is Node's built-in SQLite |
| At least one harness, installed and signed in | Signed in **on the server**, as the user that runs Tucano (see below) |
| Optional: Docker Engine | For agents' isolated Linux computers |
| Optional: Chromium or Google Chrome | For agents' browsers (`apt install chromium`) |

## Before the server release is published

The one-command URL below downloads the **latest published release**, not this branch or PR.
Use it only when that release includes this server and desktop connection support. Before then,
use the Server workflow's `tucano-server` artifact from the revision you are testing, or build
from a reviewed checkout of that revision with Node 24+:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build
sh scripts/pack-server.sh dist-server
```

If building on your Mac or another machine, copy the installer from that same revision, archive
and matching checksum to the VPS:

```sh
scp install-server.sh dist-server/tucano-server.tar.gz dist-server/tucano-server.tar.gz.sha256 tucano@vps.example.com:~/
ssh tucano@vps.example.com
```

Then, **in the VPS SSH session**, run:

```sh
TUCANO_TARBALL="$HOME/tucano-server.tar.gz" sh "$HOME/install-server.sh" --label "My Mac" --host tucano@vps.example.com
```

Replace the user/host with your own. For a build made on the VPS itself, use
`TUCANO_TARBALL="$PWD/dist-server/tucano-server.tar.gz" sh install-server.sh --label "My Mac" --host tucano@vps.example.com`
from the checkout instead. `--host` describes where the Mac connects; it **does not install on a remote machine**.
Use a desktop build with the same connection feature. To test the desktop from the matching
checkout on the Mac, install with `npm ci` **without** `ELECTRON_SKIP_BINARY_DOWNLOAD`, then run
`npm run dev`. Paste the link into the top environment selector; opening `tucano://` links requires
an installed app. Development uses its own local data folder, separate from an installed Tucano.
Do not point the installer at an unreviewed archive. The workflow artifact contains the archive
and checksum, not the installer or the Mac app.

## Install with one command

Run this **on the Linux VPS**, as the user that will run Tucano, not root. On a new VPS,
an administrator first creates that account (`sudo adduser tucano`), enables it to run services
after logout (`sudo loginctl enable-linger tucano`), and authorizes your Mac's SSH public key for
that account. Creating the account alone does not grant SSH access. Then sign in over SSH as `tucano`:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install-server.sh | sh -s -- --label "My Mac"
```

It needs `curl`, `tar`, a SHA-256 utility (`sha256sum` or `shasum`), and a working systemd user session. Download time depends on your connection. The script:

- downloads the server (one package for x64 and ARM64) and checks it against its SHA-256 checksum before it unpacks anything;
- uses the system's Node 24 if there is one, and otherwise downloads one of its own, checked against nodejs.org's checksums (nothing is installed system-wide);
- keeps the server running as a systemd **user service**: it restarts if it dies and starts at boot. It listens on `127.0.0.1:7337` only, so nothing is exposed until you choose how (see [Reaching it](#reaching-it));
- adds the `tucano-server` command to `~/.local/bin` (`pair`, `devices`, `revoke`; see [pairing.md](pairing.md));
- prints a pairing code, the link that pairs the Mac app, and the `ssh` command for a browser.

The link names the address your computer reaches the server at. Run over SSH, the script takes it from your login; to say it yourself, use `--host vps.example.com` (or `--host vps.example.com:2222`, or `--host user@vps.example.com`). Check the generated destination, especially behind NAT or a jump host: the server-side login address may not be reachable from your Mac. The app needs the real hostname/IP and an authorized key; it does not use SSH config aliases or jump hosts. Prepare [Mac SSH access](pairing.md#prepare-ssh-on-the-mac) before redeeming the code. The service journal holds neither a token nor a pairing code. Treat the code and `tucano://pair` link printed in your terminal as temporary secrets: each works once, for five minutes. Use a separate code for the Mac app and each browser.

In the Mac app, click the **environment selector at the top** (initially **This computer**), find **Add environment**, paste the link, name the environment **Personal** or **Work**, review the destination and click **Pair and connect**. If the code expires while preparing SSH, run `tucano-server pair --label "My Mac" --ssh tucano@vps.example.com` on the VPS for a fresh one. If the command is not on your PATH, use `~/.local/bin/tucano-server`.

Run the same command again to **update**: the data in `~/.tucano-server` stays, paired devices keep working, and the current and previous releases are kept. A failed service restart restores the previous program, command and unit and reports a failure. This is a binary rollback, not a database backup: back up the data folder before upgrading. `sh -s -- --uninstall` removes the service and the program (the data stays; add `--purge` to delete it too). `sh -s -- --help` lists the rest: `--port`, `--no-service`, `--pair` (a new code on an update).

The installer remembers a custom `TUCANO_DATA` from its installed command when updating or
uninstalling, together with the service port and desktop option. An explicit `TUCANO_DATA`
override still takes precedence; changing it selects a different workspace without moving data.
If that stored path cannot be read safely, the installer stops rather than silently creating a
fresh workspace. If you used custom `TUCANO_HOME`, `TUCANO_BIN` or `XDG_CONFIG_HOME`, provide
those **same location overrides** so the installer can find the right program, command and unit.
Set installer variables on the `sh` side of a download pipe, not only on `curl`; for example:
`curl -fsSL …/install-server.sh | TUCANO_DATA=/your/data/path sh -s -- --no-pair`.
After uninstalling without purge, the command containing that path is gone. To delete retained
custom data later, pass its `TUCANO_DATA` explicitly with `--uninstall --purge`, as the uninstall
message shows. Purge permanently deletes conversations, files and keys; back them up first if needed.

### Direct pairing without SSH

If you already have HTTPS forwarding to `127.0.0.1:7337` (Caddy, nginx or Tailscale Serve), install and generate the direct Mac/browser link with:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install-server.sh | sh -s -- --label "My Mac" --url https://tucano.example.com
```

`--url` only chooses the address in the pairing link. It does not create a proxy, open a firewall port, configure DNS, or change the loopback bind address. Configure and verify that route first. For an existing install, issue a new link with `tucano-server pair --label "My Mac" --url https://tucano.example.com`, or rerun the installer with `--pair --url …`. `--host` and `--url` are alternatives, not options to combine.

For Tailscale direct access, use Tailscale Serve HTTPS forwarding to `127.0.0.1:7337` and pair with the resulting `https://<machine>.<tailnet>.ts.net` URL. The Mac rejects all non-loopback HTTP URLs, including `100.64.0.0/10` and `*.ts.net`: an address alone does not prove an encrypted route.

In the Mac app's top environment selector, use **Add environment**, paste the `tucano://pair` link, and confirm. The app exchanges the code for a separate device token. SSH mode uses your Mac's key-based SSH access; direct mode uses the URL with a trusted TLS certificate. Neither mode bypasses certificate or host-key checks. To check or remove access, run `tucano-server devices` or `tucano-server revoke <id>`. See [pairing.md](pairing.md) for keychain storage, expiration and reconnect behavior.

### Optional computer on the VPS

Each VPS can optionally provide a Linux graphical session shared by that server's agents. The default remains a headless server listening only on loopback. Use separate Linux users/VPSs, data folders and device pairings for personal and work environments; enabling a desktop on one server does not enable it on another.

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
# Stop/start without deleting data or pairing:
systemctl --user stop tucano.service
systemctl --user start tucano.service
```

If there is no user session, install `dbus-user-session` on Debian/Ubuntu and log in over SSH again. An administrator can run `loginctl enable-linger tucano` so this user's service survives logout and starts at boot. `sudo -u` alone may not create a user session. The installer clears another user's inherited XDG/session-bus settings when invoked through a cross-user `sudo`; an ordinary SSH login is the simplest setup.

If you deliberately customize service environment settings, use `systemctl --user edit tucano.service`. For example, a deployment with a separately secured network/proxy may explicitly bind its own Tailscale IP (this does not enable direct HTTP pairing in the Mac app):

```ini
[Service]
Environment="TUCANO_HOST=100.64.0.2"
```

Then run `systemctl --user daemon-reload && systemctl --user restart tucano.service`. Replace the example with the server's actual address. Drop-in overrides survive installer updates. Do not set a public bind address without a secure access plan.

Changing `TUCANO_HOST` only changes where Tucano listens. It does **not** forward agents' service ports. That requires a separate opt-in described under [Agent service previews](#agent-service-previews).

For a manual binary rollback, inspect `ls ~/.local/share/tucano-server/versions`, point `current` at the retained release, and restart the service:

```bash
cd ~/.local/share/tucano-server
ln -sfn versions/<previous-release-directory> current
systemctl --user restart tucano.service
```

An unavailable service needs **Reconnect** in the app after it is running again, not a new install
or pairing code. An expired/revoked device token does require a fresh code. **Forget** in the app
only removes the saved connection on that computer; use `tucano-server devices` and
`tucano-server revoke <id>` on the VPS to revoke access. See [pairing recovery](pairing.md#recover-a-connection).

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

- **SSH tunnel**, the simplest: the Mac app opens its own tunnel when paired over SSH. For a browser instead, run `ssh -N -L 17337:127.0.0.1:7337 you@your-server` on your computer, keep that terminal open, and use `http://127.0.0.1:17337/?pair=YOUR-CODE` with a fresh code. Use a different local port for a second server. See [pairing.md](pairing.md).
- **Tailscale Serve HTTPS**: keep Tucano bound to `127.0.0.1`, expose it through Tailscale Serve with HTTPS, then pair using `https://<machine>.<tailnet>.ts.net`. Do not send pairing codes or tokens over plaintext HTTP to a tailnet address.
- **A reverse proxy with HTTPS** (Caddy, nginx) on a domain of yours: keep Tucano on `127.0.0.1` and point the proxy at it. Turn off response buffering for `/events`, which is a live event stream. For example, with Caddy:

  ```
  tucano.example.com {
    reverse_proxy 127.0.0.1:7337 {
      flush_interval -1
    }
  }
  ```

Never expose port 7337 on a public address without HTTPS.

### Agent service previews

Agent-created pages and APIs listen on the server's own loopback. **Forwarding is off by default**, even when `TUCANO_HOST` is a private LAN or Tailscale address. Pairing with Tucano, enabling a VPS desktop, or forwarding Tucano's port over SSH does not forward those service ports.

For a specific service, prefer a deliberate SSH tunnel, such as `ssh -L 5173:127.0.0.1:5173 you@your-server`, then open `http://127.0.0.1:5173` separately in your browser. Alternatively, configure and secure a separate HTTPS route for that service. Automatic embedded previews and **Open** are disabled in the server web app by default, including when its address is `localhost`: that address might only tunnel Tucano's control port. Remote Mac app previews remain disabled too. Native desktop-local previews are unchanged.

For deployments that deliberately want to expose **all running agent services** on a private interface, set `TUCANO_FORWARD_SERVICES=1` separately alongside a specific private IPv4 `TUCANO_HOST`. Only RFC1918 and `100.64.0.0/10` addresses qualify. Wildcard, public, loopback, IPv6 and hostname binds never enable this forwarding, even with the flag set.

**Warning:** these forwarded ports have no Tucano authentication or HTTPS. Anyone on the LAN/tailnet who can reach them can access the pages and APIs without pairing, and revoking a Tucano device does not revoke that network access. Restrict access with a separately managed firewall/tailnet policy and review the services before opting in. The server prints this warning at startup when forwarding is enabled. This setting changes neither Tucano's own token authentication nor its transport protections.

With that explicit opt-in, the web app only enables automatic previews when opened over HTTP at the exact private bind IP. HTTPS proxy views, alternate hostnames and SSH-tunneled views do not automatically preview those plaintext ports. Do not weaken HTTPS for Tucano to obtain a preview; use a deliberate separate service URL instead.

**Upgrade note:** private-address deployments that previously received automatic service forwarding now need this separate opt-in, or an explicit tunnel/HTTPS route. Remove the flag or set it to `0` and restart to disable automatic forwarding.

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
| `TUCANO_FORWARD_SERVICES` | `0` (off) | `1` explicitly exposes all running agent service ports on a specific private IPv4 bind address, without Tucano authentication or HTTPS; see [Agent service previews](#agent-service-previews) |
| `TUCANO_PORT` | `7337` | |
| `TUCANO_TOKEN` | a random token, kept in `server-token` | Set it to use a token of your own |

## How it differs from the desktop app

- **Connectors that sign in with OAuth** (an **Authorize in the browser** button): Tucano opens the authorization page in your browser. When you allow access, the page ends on an address starting with `http://127.0.0.1` that doesn't load, because that address is the server's own. Copy the whole address from the address bar and paste it into Tucano.
- **Secrets** (connector keys, Telegram, GitHub) are encrypted with AES-256-GCM. The key is in `server.key` in the data folder, and only your user can read that file. A desktop app keeps that key in the system's keychain instead. Back the key up together with the data folder: the secrets can't be read without it.
- **Notifications:** connect Telegram (**Settings › Phone and GitHub**) to get approvals, questions and results on your phone. The browser doesn't pop up notifications.
- **Agents' browsers** need Chromium or Chrome on the server, and run without a window. **Take over** doesn't open a window there: the live picture of the browser in the panel becomes the browser. Click on it, type, paste and scroll, then click **Hand back**. This is how you sign in to a site for an agent.
- **Pages agents serve** (a dashboard, an API) listen on the server's own `127.0.0.1`. Agents take their screenshots with the server's Chrome. They are not automatically exposed on the LAN/tailnet. Use a deliberate service tunnel or HTTPS route; forwarding all services requires the separate, unauthenticated-access opt-in described in [Agent service previews](#agent-service-previews).
- **Choosing a folder** asks for its path on the server, since the browser can't browse the server's disk.
- **No self-update.** Update by running the install script again, or with `git pull` (see above).
- **One Tucano per data folder.** Don't run the desktop app and the server on the same data folder at the same time.

## Installer regression checks

`node --test scripts/installer-test.mjs` runs without a build, network, root privileges or a real systemd session. It tests fresh installs, inherited sudo XDG settings, custom data-path preservation and explicit overrides, malformed stored paths, updates, same-version reinstall, rollback on restart failure, checksums, unsafe archives/paths, SSH/direct link forwarding, uninstall/purge behavior, and optional desktop prerequisite checks, quoting, preference preservation and disabling. Service/network commands are mocks, so this is not evidence of a live VPS or Mac connection.

The Server GitHub Actions job additionally builds the real package and tests a user service on Ubuntu: startup, pairing, process restart, update with the retained port, and uninstall with data preservation. The full app/server connection suite lives separately in `scripts/server-e2e.mjs`.
