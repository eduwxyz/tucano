# Pairing devices with the server

The server doesn't hand its own token to every browser. Each device is **paired**: it trades a
one-time code for a token of its own, so you can see who is signed in and take one device's access
away without touching the others.

## Choose the command and destination

Run pairing commands **on the VPS, as the Linux user that runs the service**. For an installer
installation, use `tucano-server` (or `~/.local/bin/tucano-server` if it is not on your PATH).
It remembers the installed service's data directory and port. For a source build, replace
`tucano-server` with `node out/main/server.js`, run from the built checkout, and use the same
`TUCANO_DATA` and `TUCANO_PORT` as the running server. A code made against another data folder
will not work on your service.

Prepare the route before making a five-minute code:

- **SSH:** the app manages a tunnel; no HTTPS setup or public Tucano port is needed. Follow
  [Prepare SSH on the Mac](#prepare-ssh-on-the-mac) first.
- **Direct HTTPS:** configure a reverse proxy or Tailscale Serve HTTPS to the server's
  `127.0.0.1:7337` first. Use its root origin, such as `https://tucano.example.com`, with no
  path, query or embedded password. The certificate must be trusted by the Mac. `--url` only
  describes this route; it does not configure the proxy, DNS, firewall or certificate.
- **Browser over SSH:** open a tunnel in your own terminal and keep it running. The app's
  managed tunnel is not a browser-sharing feature. See [Reaching it](server.md#reaching-it).

### Prepare SSH on the Mac

The VPS account must already authorize your public key. Verify the host fingerprint through
your provider, then connect once from the Mac's Terminal with the **same real hostname/IP and
SSH port** you will put in the link. Accept the host key only after verifying the fingerprint:

```sh
ssh -F /dev/null -p 22 tucano@vps.example.com
```

Run the following in a separate Mac terminal, not on the VPS, using your actual private-key path:

```sh
ssh-add ~/.ssh/id_ed25519
ssh-add -l
ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -p 22 tucano@vps.example.com true
```

The last command should finish without a password or host-key prompt. It is a useful check of
key-based access, not a test of the Tucano service. Tucano uses OpenSSH without reading your SSH
config files: aliases, `IdentityFile`, `ProxyJump`, `ProxyCommand` and custom known-hosts paths
are not applied. Use the real host and put non-default keys in the agent available to Tucano.
The app does not prompt for SSH passwords or key passphrases and never accepts a host key for
you. Do not remove a changed host key until you have verified why it changed. For a route that
requires your own SSH config, manage a local tunnel yourself and use its loopback URL, or use HTTPS.

## Pair a device

On the VPS, generate a new code:

```sh
tucano-server pair --label "My Mac"
```

It prints a code like `K7QM-2XPD-9TWH` and a link, `http://127.0.0.1:7337/?pair=K7QM-2XPD-9TWH`. With
`--ssh` (or `--url`) it also prints the link that pairs the **Mac app**:

```sh
tucano-server pair --label "My Mac" --ssh you@203.0.113.7
# tucano://pair?v=1&code=K7QM-2XPD-9TWH&ssh=you%40203.0.113.7&name=My+Mac
```

`--label` names the **device** in the VPS's device list. Set the separate **environment name**
to **Personal** or **Work** when confirming the link in the app. The generated link initially
suggests the device label, but renaming the environment does not change the device's label.

- `--ssh user@host[:port]` is how the app reaches this machine: it opens an SSH tunnel to the server's own
  loopback, so no port is open to the internet. The user is the one you sign in to the server as.
- `--url https://tucano.example.com` is for a server reached at an address instead (a reverse proxy with HTTPS,
  or Tailscale Serve HTTPS: `https://vps.tail1234.ts.net`). Plain `http` is accepted only on localhost/loopback, including a local SSH tunnel. A Tailscale IP or hostname alone does not prove traffic is encrypted.
- The link is read by `src/shared/pairlink.ts`. It comes from outside (a chat, a web page) and ends up as an
  `ssh` command, so a link whose user or host could pass for an `ssh` option (`-oProxyCommand=…`), carries
  anything beyond a name and an address, or gives a part twice, is refused whole.
- A wrong `--ssh` or `--url` is said before any code is made, so a typo doesn't use one up.

About the code:

- It works **once**, for **one device**, for **5 minutes**.
- Use it in the Mac app **or** a browser, not both. Opening the browser link consumes the code;
  run the pairing command again for the app or another browser. Generate a fresh code if setup
  took longer than five minutes. Neither an expired code nor a new code stops the server.
- **In a browser:** open the link (through your SSH tunnel, Tailscale Serve HTTPS or HTTPS proxy: use the address
  you reach the server at). The browser trades the code for its own token, kept in a cookie, and the
  address bar goes back to `/`.
- **From the app or a script:** trade the code by `POST /pair` (below) and keep the token.
- The device's token lasts **30 days from its last use**. Using it renews it.
- The server keeps only a hash of the code and of each token, in `pairing.json` in the data directory
  (readable only by the server's user).

## Select Personal, Work, or another environment in the desktop app

The connection button at the top of the app is always available, including onboarding and when a
saved server is offline. Choose **This computer** or a named VPS. Add any number of independent
servers, for example **Personal**, **Work**, and **Staging**. Each entry shows its destination,
transport and connection state. Rename an entry without pairing again.

1. Prepare and verify SSH or HTTPS as described above. Run `tucano-server pair --label "My Mac" --ssh you@your-vps` on that VPS, or use
   `--url https://tucano.example.com` for HTTPS/Tailscale.
2. Open the `tucano://pair?...` link in the installed app, or click the **environment selector
   at the top** (initially **This computer**) and paste it under **Add environment**.
   In development, paste the link; protocol registration belongs to the installed application.
3. Review the destination, optionally name the environment, and click **Pair and connect**.
   Opening a link alone never runs SSH or redeems a code. Manual SSH/address and code fields
   are available too.
4. Confirm the top selector shows the intended environment before creating agents or connecting
   tools. On a fresh VPS, complete setup and sign the harnesses in on that VPS. Repeat separately
   for the other VPS; **This computer** continues to use your local workspace.

Selection changes the workspace on screen; it does not copy agents, messages, connectors, keys or
files between servers. Personal and Work are separate server instances/databases, not folders with
different names in one shared account. The local core stays running while the desktop app is open;
VPS agents keep running even after the app closes or switches to another server. Local notifications
are labelled Local when a VPS is selected and return to the local workspace when clicked.

Each saved connection has an independent encrypted device token. The app stores ciphertext in its
connection metadata file, encrypted using Electron safeStorage with an OS-protected secret (macOS
Keychain-backed; Windows DPAPI). The renderer never receives the token.
The application refuses plaintext/fallback key storage. A locked/unavailable keychain requires the
owner to unlock it, not a bypass. A new connection also checks the saved server ID at `/identity`
before sending a bearer token (update older servers first), so a new database at the same address is not silently treated as the
old environment. This server ID is a mismatch guard, not a cryptographic identity pin: TLS certificate
verification or SSH host-key verification authenticates the transport. Re-pair deliberately after verifying a changed server. Pairing the same server and
transport again replaces its local credential while preserving its name rather than duplicating it.
Legacy plaintext HTTP Tailscale connections remain visible for rename/removal, but cannot unlock or
send their token. Configure HTTPS and pair again explicitly; the app never silently rewrites the URL.

Connection loss is visible. Use **Reconnect** after fixing the service/network; failed requests are
not replayed automatically, since an action might already have run. A failed switch keeps the prior
connected environment. **Forget** removes only that computer's saved connection/token; revoke the
device on the VPS to invalidate its server-side access.

### Recover a connection

| What you see | What to do |
| --- | --- |
| Invalid, expired or already-used pairing code | Generate a fresh code on the correct VPS/service account and pair again. Do not open its browser link first if pairing the app. |
| Unknown or changed SSH host key | Verify the host fingerprint with the provider, then connect in Terminal to the exact host and SSH port. Never disable host checking. |
| SSH key authentication failed | Authorize the matching public key on the VPS and load your private key into the Mac's SSH agent. Check the explicit host, user and port without SSH config aliases. |
| Service unavailable or connection lost | Check `systemctl --user status tucano.service` on that VPS and the network route, then choose **Reconnect**. A normal restart does not require pairing again. |
| Device token expired or revoked | Generate a fresh code on the VPS and pair again. If a code was consumed before a failed save, make another one. |
| Server identity unavailable | Update the VPS to a build supporting `/identity`; the desktop will not send a saved token to an unidentified older server. |
| Server identity changed | Check whether the VPS/data folder was replaced and verify its SSH host key or HTTPS certificate. Re-pair deliberately only after confirming the new destination. |
| Keychain/secret storage unavailable | Unlock or restore the operating system's protected storage, then retry. The app does not fall back to plaintext token storage. |

Failed requests are not replayed automatically. Check the workspace before repeating a write,
because the server may have completed it before the connection failed. Revoking a device does
not stop its VPS or delete agents/data. To stop remote work, pause it in that environment or stop
the service on that VPS.

The existing [browser and Linux computer](server.md) run on the selected VPS. Browser takeover is
controlled from the live browser panel, not by opening a browser on the Mac. The optional
[Linux graphical session](vps-desktop.md) enables explicitly granted desktop apps on the server.
It is shared within the service user's session, not one private graphical desktop per agent.

Agent-created web service ports are separate from the Tucano control port. The native remote client
does not yet automatically forward those preview ports; their embedded preview is disabled rather
than accidentally opening the same port on the Mac. Use a deliberate SSH port forward or an HTTPS
URL for those pages. This limitation does not affect RPC, events, artifacts, or browser takeover.

## Trading a code from a program

```sh
curl -s -X POST http://127.0.0.1:7337/pair -d '{"code":"K7QM-2XPD-9TWH","label":"My Mac"}'
```

It answers `200` with the device's token, once:

```json
{ "server": "9f2c41ab07de", "token": "tk_…", "device": { "id": "…", "label": "My Mac" }, "days": 30 }
```

Keep the token (the Mac app stores only encrypted ciphertext in its connection file, protected by
a macOS Keychain-backed secret through Electron safeStorage) and send it with every request as
`Authorization: Bearer tk_…`. No cookie is set. `server` is the server's id, to tell servers apart.
The label is only used if the code was made without `--label`.

| Answer | Means | Counted as a wrong token |
| --- | --- | --- |
| `200` | paired | no (and it clears the count) |
| `401` | wrong, used or expired code | yes |
| `400` | not JSON, or no `code` | no |
| `403` | the request names another site as its `Origin` | no |
| `413` | body over 4 KB | no |
| `429` | too many wrong tokens or codes from this address | |

## More than one server

Each server has an id of its own (`server-id` in its data directory) and names its cookie
`tucano-<id>`. A cookie belongs to a host, not to a port: two servers reached through tunnels on
`127.0.0.1` (ports 17337 and 17338, say) would otherwise take each other's cookie, and signing in to one
would sign you out of the other. A token is only good on the server that made it.

## See and revoke

```sh
tucano-server devices             # id, label, paired, last seen
tucano-server revoke DEVICE_ID     # the exact device ID from that list
tucano-server revoke "My Mac"      # every device with this label; quote spaces
tucano-server revoke --all         # every device, and the codes not used yet
```

Prefer the exact ID if multiple devices have the same label. For a lost Mac, run the revoke
command through another authorized SSH session on each affected VPS; forgetting a profile on
another computer does not revoke the lost Mac. Pairing again adds/replaces the local profile but
does not automatically revoke an older server-side device token. Review `devices` and revoke
stale entries explicitly.

A revoked device is refused on its next request, and a page it already has open is cut within half a
minute. The refusal also takes its cookie back, so a page left open doesn't go on being counted as
wrong guesses.

## The server's own token

`…/?token=…` and `Authorization: Bearer <token>` still work, for scripts and for what you set up before
pairing. The token is in `server-token` in the data directory: the server **doesn't print it** at start,
because a log (`journalctl`, a file) is read by more people than the one who owns the server. What it
prints, when nobody is paired yet, is a pairing code. Signing in with the token gives the browser a
device token of its own, so the server's own token never sits in a cookie.

The cookie from before pairing (named `tucano`) isn't read any more: open the link once more to sign
in again. To cut the server's own token, set a new `TUCANO_TOKEN` (or delete `server-token` in the
data directory and restart).

## Wrong codes

A wrong code counts like a wrong token: 10 in 10 minutes from one address, then a wait (see
`guard.ts`). With 12 characters from a 32-character set a code has 60 bits, and it dies in 5
minutes. Through an SSH tunnel every device reaches the server from `127.0.0.1`, so they share the count.

## Two writers at once

`pair`, `revoke` and a session renewing all write `pairing.json`. Each takes a lock for the moment it
writes (`pairing.json.lock`) and works from what the file holds then, so a `revoke` can't be undone by a
renewal that read the file a moment earlier. A lock older than 10 seconds is taken to be left by a
process that died, and is removed. If the file stays busy for 5 seconds, the command says so and
exits with 1; the server never waits more than half a second just to renew a session.
