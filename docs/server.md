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

## Install

As the user that will run Tucano (not root):

```bash
git clone https://github.com/eduwxyz/tucano.git
cd tucano
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # the server doesn't need Electron itself
npm run build
npm run server
```

Then, in another terminal, get the link that signs a browser in:

```bash
npm run server -- link     # http://127.0.0.1:7337/?token=…
```

Open that link once. The token signs the browser in, and a cookie keeps it signed in. The token lives in `~/.tucano-server/server-token`, and `link` is the only thing that prints it: the log never does. To sign every browser out, delete that file and restart Tucano.

### Signing the harnesses in

Install the harnesses on the server, in a terminal over SSH, as the user that runs Tucano:

```bash
curl -fsSL https://claude.ai/install.sh | bash
npm install -g @openai/codex
```

Then sign them in from Tucano's **Settings › Models**, in the browser or the iPhone app: **Sign in** runs the harness's own login in a terminal of the server's and shows its screen in a window, with **Open the sign-in page**, the code to type there, a field to paste a code back and the arrow keys for a menu. Each harness signs in the way that works with no browser on the server: Codex and Grok with a device code (`codex login --device-auth`, `grok login --device-auth`), Claude Code with a code you paste back, Cursor on its own once you approve the page, OpenCode and Gemini in their own menus, and Pi with `/login` on its screen. Tucano passes keys and shows the screen; the login is saved where the harness always keeps it. This needs Linux (it uses `script`, from util-linux); elsewhere **Sign in** shows the command to run over SSH.

### On a phone

The Tucano app for iPhone signs in with a one-time code, not the token. On the server, run:

```bash
npm run server -- pair          # tucano://connect?url=…&code=…   and   https://…/?code=…
npm run server -- pair 1440     # good for a day instead of 10 minutes (up to a week: 10080)
```

Open the first line on the phone (or show it as a QR code and point the Camera at it). The app trades the code for a key of its own, and the code stops working. The second line does the same for a browser. The same link opens it in the desktop app, in **Settings › Servers › Connect to a server**, which trades the code for a key of that computer's own. Once you're signed in, **Settings › People › Connect a phone** makes a code too, as a QR code, for whoever is signed in: each person connects their own phone, as themselves. Each phone has its own key; removing someone ends all of theirs. The app needs the server on HTTPS (a reverse proxy, below), or on `127.0.0.1` while testing.

Someone you invite can also open the invite link in the app: it asks their name, and they're in.

## Reaching it

By default the server only listens on the server itself (`127.0.0.1`), because anyone who has the token controls your agents. Pick one of these ways to reach it:

- **SSH tunnel**, the simplest: run `ssh -L 7337:127.0.0.1:7337 you@your-server`, then open the printed link on your computer.
- **Tailscale** (or another private network): set `TUCANO_HOST` to the server's Tailscale address, then open `http://<that address>:7337/?token=…` from any of your devices, including your phone.
- **A reverse proxy with HTTPS** (Caddy, nginx) on a domain of yours: keep Tucano on `127.0.0.1` and point the proxy at it. Set `TUCANO_URL` to the address people open, so `link` prints it, and `TUCANO_TRUST_PROXY=1`, so wrong tokens are counted per visitor rather than all as the proxy. Turn off response buffering for `/events`, which is a live event stream, and keep the proxy's access log off or without query strings, since the first link carries the token. For example, with Caddy:

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

Then run `sudo systemctl enable --now tucano`. The logs are in `journalctl -u tucano`; the link to sign in comes from `npm run server -- link`, run as the same user in the same folder.

To update Tucano, run `git pull && npm ci && npm run build && sudo systemctl restart tucano`.

## Settings

| Variable | Default | |
|---|---|---|
| `TUCANO_DATA` | `~/.tucano-server` | Where everything is kept: database, memory, agents' files, the key and the token |
| `TUCANO_HOST` | `127.0.0.1` | The address to listen on |
| `TUCANO_PORT` | `7337` | |
| `TUCANO_TOKEN` | a random token, kept in `server-token` | Set it to use a token of your own |
| `TUCANO_URL` | where it listens | The address people open, behind a proxy (`https://tucano.example.com`): what `link` prints |
| `TUCANO_PUSH_URL` | `https://tucano.sh/api/push` | The relay that delivers notifications to the iPhone app while it's closed (`site/push.js`), or `off`. The relay gets each notification's title and line, and the phone's handle, and keeps nothing |
| `TUCANO_TRUST_PROXY` | off | `1` behind a reverse proxy: each visitor's address comes from `X-Forwarded-For` |

Once a browser has the cookie, the server answers only its own page: a page of another site (a sibling subdomain included) can't call it, and no site can show it inside a frame. Twenty wrong tokens from one address in ten minutes lock that address out for ten minutes.

## How it differs from the desktop app

- **Connectors that sign in with OAuth** (an **Authorize in the browser** button): Tucano opens the authorization page in your browser. When you allow access, the page ends on an address starting with `http://127.0.0.1` that doesn't load, because that address is the server's own. Copy the whole address from the address bar and paste it into Tucano.
- **Secrets** (connector keys, Telegram, GitHub) are encrypted with AES-256-GCM. The key is in `server.key` in the data folder, and only your user can read that file. A desktop app keeps that key in the system's keychain instead. Back the key up together with the data folder: the secrets can't be read without it.
- **Notifications:** connect Telegram (**Settings › Phone**) to get approvals, questions and results on your phone. The browser doesn't pop up notifications.
- **Agents' browsers** need Chromium or Chrome on the server, and run without a window. **Take over** doesn't open a window there: the live picture of the browser in the panel becomes the browser. Click on it, type, paste and scroll, then click **Hand back**. This is how you sign in to a site for an agent.
- **Pages agents serve** (a dashboard, an API), behind a reverse proxy with HTTPS (`TUCANO_URL`): each opens at `https://<port>-<your address>`, with a sign-in of its own that Tucano hands the panel. The proxy has to send those names to Tucano too (`*.tucano.example.com`, with a certificate for each name: Caddy's on-demand TLS does it). Otherwise, they listen on the server's own `127.0.0.1`. Agents take their screenshots with the server's Chrome. When Tucano listens on a private address (Tailscale or a home network), it also passes each running page through on the same port at that address, so the preview panel and **Open** work from your computer. That doesn't happen on a public address, because those pages have no token. Over an SSH tunnel, forward the page's port too (`-L 5173:127.0.0.1:5173`).
- **Choosing a folder** asks for its path on the server, since the browser can't browse the server's disk.
- **No self-update.** Update with `git pull` (see above).
- **One Tucano per data folder.** Don't run the desktop app and the server on the same data folder at the same time.
