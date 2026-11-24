# Tucano on a server

Tucano can run on a server you own, such as a VPS or a machine at home. On a server, routines keep running when your computer sleeps, and you use Tucano from a browser, on any computer or phone. The server runs Tucano's core on plain Node and serves the app's own screens to the browser. Nothing goes through a Tucano service: the server is yours, and so are the data and the logins on it.

Status: **new.** It's what the Tucano Pro servers run, one container per person, with real agents, since November 2026. Tested on Linux (Debian 12, Node 24) and macOS.

There are two ways to put it on a server: the **Docker image** (below), with the harnesses and Chromium already in it, or **from the source**, with Node.

## With Docker

The image is the one the Tucano Pro servers run: Tucano, Chromium for the agents' browsers, and the harnesses (Claude Code, Codex, Gemini, OpenCode, Pi, Cursor, Grok and Antigravity), for Linux x64 and ARM64. Each release publishes it as `ghcr.io/eduwxyz/tucano`, with the version (`0.2.35`) and `latest`.

```bash
docker run -d --name tucano --restart unless-stopped \
  -p 127.0.0.1:7337:7337 -v tucano:/home/tucano \
  ghcr.io/eduwxyz/tucano:latest
docker exec tucano node out/main/server.js link     # the link that signs a browser in
```

Everything is in the `tucano` volume: the database, memory, agents' files, the harnesses' logins, the key and the token. Sign the harnesses in from **Settings › Models** (below), with no SSH. For the phone, `docker exec tucano node out/main/server.js pair`.

Inside the container Tucano listens on every address, so `-p` decides who reaches it: keep `127.0.0.1:` and reach it through one of the ways under **Reaching it**. Pass the settings (below) with `-e`, for example `-e TUCANO_URL=https://tucano.example.com -e TUCANO_TRUST_PROXY=1` behind a proxy.

To update, pull the new image and start the container again with the same command; the volume stays:

```bash
docker pull ghcr.io/eduwxyz/tucano:latest && docker rm -f tucano
```

The Pro servers also run each container with no privileges and a read-only system, which the image supports. With Docker Compose:

```yaml
services:
  tucano:
    image: ghcr.io/eduwxyz/tucano:latest
    restart: unless-stopped
    ports: ['127.0.0.1:7337:7337']
    volumes: ['tucano:/home/tucano']
    read_only: true
    tmpfs: ['/tmp:size=1g,mode=1777']
    shm_size: 256m
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
volumes:
  tucano: {}
```

In the container, an agent's computer is **This computer** (the container itself) or **None**. The isolated Linux computer needs Docker, and the container has none: don't hand it the host's Docker socket, which would give the agents the whole server.

To build the image yourself, `docker build -t tucano .` in a clone.

## What you need

| | |
|---|---|
| Linux, x64 or ARM64 | Any VPS with 2 GB of RAM or more |
| [Node.js](https://nodejs.org) 24+ | Tucano's database is Node's built-in SQLite |
| At least one harness, installed and signed in | Signed in **on the server**, as the user that runs Tucano (see below) |
| Optional: Docker Engine | For agents' isolated Linux computers |
| Optional: Chromium or Google Chrome | For agents' browsers (`apt install chromium`) |

## From the source

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

The Docker image has them already. From the source, install them on the server, in a terminal over SSH, as the user that runs Tucano:

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
- **A reverse proxy with HTTPS** (Caddy, nginx) on a domain of yours: keep Tucano on `127.0.0.1` and point the proxy at it. Set `TUCANO_URL` to the address people open, so `link` prints it, and `TUCANO_TRUST_PROXY=1`, so wrong tokens are counted per visitor rather than all as the proxy. Turn off response buffering for `/events` and `/node/link`, which are live event streams, and keep the proxy's access log off or without query strings, since the first link carries the token. For example, with Caddy:

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
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | none | An outbound proxy for connectors and the server's other requests (`http://user:password@proxy:3128`); `localhost` never goes through it |
| `TUCANO_SYSTEM_CA` | on | Tucano trusts the system's root certificates (`/etc/ssl`) as well as Node's, for a network that inspects HTTPS; `0` turns that off |

Once a browser has the cookie, the server answers only its own page: a page of another site (a sibling subdomain included) can't call it, and no site can show it inside a frame. Twenty wrong tokens from one address in ten minutes lock that address out for ten minutes.

## Traces with OpenTelemetry

Tucano can send a trace of its agents' work to any backend that takes OTLP over HTTP. It's off until you set an endpoint, and nothing goes to the people who make Tucano.

**From the app:** an admin sets it in **Settings › Connections › Traces**:
- **The address:** the base address the backend gives. Examples fill it in for Langfuse, Grafana Cloud and a local Collector. Tucano adds `/v1/traces` and sends JSON.
- **Headers:** one per line, as `Authorization: Basic …`. They are stored encrypted and never shown again.
- **Test connection:** sends one test trace and says whether the backend took it.

A remote address needs `https://`. Plain `http://` works only for `localhost`. Changes apply at once, and each workspace has its own setting. Every change goes to **Settings › Workspace › Activity** with who made it and the address's origin, never the headers.

**From the environment,** on a server:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20your-key
```

When the environment names an endpoint, it wins: the screen shows it as configured by the server's environment, and can't change it. Only the environment Tucano's process starts with counts. Your login shell's profile never configures traces, because an agent that can edit `~/.zshrc` could otherwise send your conversations to a server of its own. So a desktop app opened from the Finder has no traces. Started from a terminal, it also needs `TUCANO_OTEL=1`, since your terminal may hold `OTEL_*` variables for another tool.

| Variable | Default | |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | The backend's address. Traces go to `/v1/traces` under it |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | none | The full traces address, used exactly as written. Wins over the one above |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | none | `key=value,key2=value2`, percent-encoded. The second wins, key by key |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/protobuf` | Or `http/json`. gRPC isn't supported |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | the exporter's | In milliseconds |
| `OTEL_SERVICE_NAME` | `tucano` | |
| `OTEL_RESOURCE_ATTRIBUTES` | none | Extra attributes on every span, such as `deployment.environment.name=prod` |
| `OTEL_SDK_DISABLED`, `OTEL_TRACES_EXPORTER` | | `true` and `none`, respectively, turn traces off even with an endpoint |
| `TUCANO_OTEL` | off | On the desktop app, `1` is required for the variables above to count |

- **A trace** is one execution of one agent's reply. Its tool calls are child spans, and so is one `chat <model>` span for the reply's model calls, with its tokens, cost (`gen_ai.usage.cost`) and the model id the harness reports (`gen_ai.response.model`). Backends such as Langfuse count usage on that span. A harness runs as a whole, so its separate model calls aren't separate spans.
- **`session.id`** is the task: every reply it set off, across agents. `gen_ai.conversation.id` is the conversation. A reply another agent asked for has a span link to the reply that asked, except a hand-off that had to wait for that agent to finish another reply.
- **Other model calls** (router, titles, memory, wiki, classifiers) are short traces of their own, marked with `tucano.operation`.
- **Spans carry no content** unless an admin turns on **Send the conversation text** in Settings › Connections › Traces. By default they hold agent names, harness, model, duration, status, tokens, cost and tool names. They hold no prompt, reply, tool arguments, tool results, error text, attachments or names of people. Name your agents with that in mind. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` isn't supported: setting it only logs a warning.
- **With the conversation text on,** each reply span carries the message it answers and its final reply, as `gen_ai.input.messages` and `gen_ai.output.messages`. Nothing else is sent: tool calls, attachments, memory, wiki, work handed over from another conversation and Tucano's own model calls stay metadata only. When the server's environment configures traces, no text is sent at all.
  - **Masking:** every Vault key's value becomes `[cofre:NAME]` first, and known token shapes are masked too. A key kept as a 1Password reference is masked only once a use has read it. A secret typed loose in a message that isn't in the Vault and doesn't look like a token still goes out, just as it already goes to the model's provider.
  - **Whose conversations:** text goes only from conversations the admin who turned it on can read. Someone else's DM keeps sending metadata only. If that admin stops being an admin, the text stops.
  - **A new address or new headers turn it off,** until an admin turns it on again for them.
- **Where traces go is in the log.** At startup Tucano writes the endpoint's address. On a server started by hand, your shell profile's variables count, so prefer the service's own environment (systemd, Docker).
- **A collector that's down never affects a reply.** Spans wait in a bounded queue and are dropped when it's full.
- **Don't give Tucano a backend key that agents could use.** Tucano removes the `OTEL_*` variables from what agents and harnesses inherit, so a harness's own OpenTelemetry settings don't reach it through Tucano either. But the operating system keeps a process's original environment, and a program running as the same user can read it (`ps eww`, `/proc`). So an agent running directly on the machine, outside its isolated computer, or a connector run by the same user, could read the key. The safe setup is a **local OpenTelemetry Collector** on `127.0.0.1`: point Tucano at it with no headers, and let the collector hold the key.

## Your harness over MCP

The server answers MCP at `/mcp` on its own address (`https://tucano.example.com/mcp`), so Claude Code, Codex, Cursor, OpenCode or any MCP client can understand the team, talk to the agents and set Tucano up from where you already work. Each harness needs a key of its own: make one in **Settings › Harnesses**, which shows the key once with what to paste into each harness. A key acts as the person who made it, with what they can do in the app, up to the level picked (read, talk, configure). Nothing over MCP deletes anything, decides approvals, or touches people, logins or secrets.

The key goes in an `Authorization: Bearer` header; the path takes no cookie. A reverse proxy in front of Tucano passes `/mcp` like any other path; keep its timeout above a minute, since a call can wait up to 45 seconds for an agent's answer. claude.ai and ChatGPT reach only a public `https://` address, and they need a sign-in Tucano doesn't offer yet (only keys, for now).

## How it differs from the desktop app

- **Your computer's terminal, files, browser and apps** stay on your computer. To let the server's agents use them, lend it from the desktop app (**Settings › Servers › Let this server use this computer**): see [Your computer lent to a server](local-node.md).
- **Connectors that sign in with OAuth** (an **Authorize in the browser** button): Tucano opens the authorization page in your browser. When you allow access, the page ends on an address starting with `http://127.0.0.1` that doesn't load, because that address is the server's own. Copy the whole address from the address bar and paste it into Tucano.
- **Secrets** (connector keys, Telegram, GitHub) are encrypted with AES-256-GCM. The key is in `server.key` in the data folder, and only your user can read that file. A desktop app keeps that key in the system's keychain instead. Back the key up together with the data folder: the secrets can't be read without it.
- **Notifications:** the Tucano desktop app shows the notifications of the servers connected to it (**Settings › Servers**) as its own, while the app runs, and the iPhone app gets them too. A browser shows them only over HTTPS (a reverse proxy, or `tailscale serve`): over plain `http://` on a Tailscale or home address, browsers show none. Telegram (**Settings › Phone**) works either way. **Settings › General › Notifications › Send one** tests them.
- **Agents' browsers** need Chromium or Chrome on the server, and run without a window. **Take over** doesn't open a window there: the live picture of the browser in the panel becomes the browser. Click on it, type, paste and scroll, then click **Hand back**. This is how you sign in to a site for an agent.
- **Pages agents serve** (a dashboard, an API), behind a reverse proxy with HTTPS (`TUCANO_URL`): each opens at `https://<port>-<your address>`, with a sign-in of its own that Tucano hands the panel. The proxy has to send those names to Tucano too (`*.tucano.example.com`, with a certificate for each name: Caddy's on-demand TLS does it). Otherwise, they listen on the server's own `127.0.0.1`. Agents take their screenshots with the server's Chrome. When Tucano listens on a private address (Tailscale or a home network), it also passes each running page through on the same port at that address, so the preview panel and **Open** work from your computer. That doesn't happen on a public address, because those pages have no token. Over an SSH tunnel, forward the page's port too (`-L 5173:127.0.0.1:5173`).
- **Choosing a folder** asks for its path on the server, since the browser can't browse the server's disk.
- **No self-update.** Update with `git pull` (see above).
- **One Tucano per data folder.** Don't run the desktop app and the server on the same data folder at the same time.
