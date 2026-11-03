# Pairing devices with the server

The server doesn't hand its own token to every browser. Each device is **paired**: it trades a
one-time code for a token of its own, so you can see who is signed in and take one device's access
away without touching the others.

## Pair a device

On the machine the server runs on:

```sh
node out/main/server.js pair --label "My Mac"
```

It prints a code like `K7QM-2XPD-9TWH` and a link, `http://127.0.0.1:7337/?pair=K7QM-2XPD-9TWH`. With
`--ssh` (or `--url`) it also prints the link that pairs the **Mac app**:

```sh
node out/main/server.js pair --label "My VPS" --ssh you@203.0.113.7
# tucano://pair?v=1&code=K7QM-2XPD-9TWH&ssh=you%40203.0.113.7&name=My+VPS
```

- `--ssh user@host[:port]` is how the app reaches this machine: it opens an SSH tunnel to the server's own
  loopback, so no port is open to the internet. The user is the one you sign in to the server as.
- `--url https://tucano.example.com` is for a server reached at an address instead (a reverse proxy with HTTPS,
  or Tailscale: `http://100.x.y.z:7337` or a `*.ts.net` name). Plain `http` is refused anywhere else.
- The link is read by `src/shared/pairlink.ts`. It comes from outside (a chat, a web page) and ends up as an
  `ssh` command, so a link whose user or host could pass for an `ssh` option (`-oProxyCommand=…`), carries
  anything beyond a name and an address, or gives a part twice, is refused whole.
- A wrong `--ssh` or `--url` is said before any code is made, so a typo doesn't use one up.

About the code:

- It works **once**, for **one device**, for **5 minutes**.
- **In a browser:** open the link (through your SSH tunnel, Tailscale address or proxy: use the address
  you reach the server at). The browser trades the code for its own token, kept in a cookie, and the
  address bar goes back to `/`.
- **From the app or a script:** trade the code by `POST /pair` (below) and keep the token.
- The device's token lasts **30 days from its last use**. Using it renews it.
- The server keeps only a hash of the code and of each token, in `pairing.json` in the data directory
  (readable only by the server's user).

## Trading a code from a program

```sh
curl -s -X POST http://127.0.0.1:7337/pair -d '{"code":"K7QM-2XPD-9TWH","label":"My Mac"}'
```

It answers `200` with the device's token, once:

```json
{ "server": "9f2c41ab07de", "token": "tk_…", "device": { "id": "…", "label": "My Mac" }, "days": 30 }
```

Keep the token (the Mac app keeps it in the Keychain, not in a file) and send it with every request as
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
node out/main/server.js devices            # id, label, paired, last seen
node out/main/server.js revoke <id|label>  # one device
node out/main/server.js revoke --all       # every device, and the codes not used yet
```

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
