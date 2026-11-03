# Remote desktop connection validation

## Run the real-server suite

From a clean checkout with dependencies installed:

```sh
npm run build
TUCANO_REMOTE_E2E=1 npx vitest run test/remote-live.test.ts
```

The test suite imports the production desktop `RemoteClient` and `RemoteStore`, launches the
built `out/main/server.js` in separate Node processes, and uses real HTTP and server-sent events.
It does not replace the server, fetch implementation, RPC handler, or event stream with mocks.
The normal `npm test` run skips this suite so it does not silently depend on a pre-existing build.
Always rebuild first when changing server code.

Covered end to end:

- The server CLI creates a one-use pairing link, parsed by the same parser as the desktop.
- Pairing obtains a device token and the owner-provided device label. Reusing the code fails.
- The event stream completes the hello handshake and transports snapshot RPC responses.
- Creating a channel produces both its RPC response and the real conversation event.
- Artifacts reject unauthenticated HTTP but can be retrieved through the desktop transport.
- An unrelated asset URL cannot be used to forward the token to a third-party host.
- Saving/reloading the remote profile and encrypted token survives creating a new store instance.
- Stopping/restarting the server is detected as a disconnected stream; reconnecting with the
  saved credentials preserves the channel and artifact without pairing again.
- A second server rejects the first server's device token.
- CLI revocation rejects RPC on an existing connection and prevents reconnecting.
- Server output, SSH daemon output, client status, and RPC events do not contain the device token.
  Server output also does not contain its owner token.

All servers bind to dynamically allocated loopback ports and use disposable data directories.
No deployed VPS, personal database, real account credential, or public listener is used.

## Actual SSH tunnel test

On a Unix host with OpenSSH client, `ssh-keygen`, and `sshd` installed:

```sh
TUCANO_REMOTE_E2E=1 TUCANO_REMOTE_SSH_E2E=1 npx vitest run test/remote-live.test.ts
```

The second test starts an isolated SSH daemon using a temporary configuration and two newly
generated Ed25519 keys. It invokes the production `openSshTunnel` through `RemoteClient`, pairs,
opens the SSE connection, creates a channel, and reads the resulting snapshot over an actual SSH
local forward. A test-local executable wrapper adds only the fixture identity and known-hosts
file to the real `/usr/bin/ssh`; the production code still chooses the forwarding arguments and
manages the tunnel process. Replacing the known host key must cause a hard failure.

No system SSH configuration, home-directory `authorized_keys`, `known_hosts`, or SSH agent is
modified. Password authentication is disabled, and the daemon only listens on loopback.
Fixture processes and files are cleaned up on success or failure. The SSH test runs only with `TUCANO_REMOTE_SSH_E2E=1`, which requires the tools and makes their
absence a test failure. Without that flag it is explicitly skipped. A present but unusable daemon fails rather than claiming a pass.

## Renderer and controller checks

`npm run test:connections` serves the built renderer and exercises its connection picker through
Playwright Chromium. The desktop API is a fixture: it checks UI behavior, not Electron or the OS
keychain. `test/remote-controller.test.ts` imports the production main process with mocked Electron
and network boundaries, checking multi-environment transitions, concurrent/failed switching,
late response isolation, offline startup, deep links, rename and forgetting.

The renderer journeys cover zero, two and twenty saved environments, separate selection and
pairing views, keyboard focus, invalid-field associations, measured light/dark text contrast,
360px reflow and a 550×425 CSS viewport (the layout equivalent of a 1100×850 window at 200%
zoom). They also exercise an incoming pairing link during another request and an acknowledged
message send with text/images, navigation, failure and explicit retry. Browser bridge fixtures
are synthetic and do not establish a real VPS connection.

`test/session-drafts.test.ts` and `test/preload-drafts.test.ts` cover in-memory draft snapshots
scoped to a profile and verified server identity, including identical conversation IDs across
Local/Personal/Work and late unload after forgetting. Unsent drafts stay in process memory,
never browser storage or the VPS. Quitting the app still clears them; this is not a durable
outbox. A failed send acknowledgment keeps the draft for review and does not resend it
automatically, because the server may already have received the message.

## Unsigned macOS packaging check

The macOS CI job packages the built app with signing, notarization and publishing disabled,
then runs `node scripts/check-mac-package.mjs dist-ci`. It verifies the bundle identifier,
`tucano://` registration in the generated Info.plist, executable, packaged main/core/server and
preload entry points, renderer assets, shared chunks, icons and sounds. The check inspects the
actual app bundle and ASAR archive without launching the app or accessing a keychain.

This is packaging evidence only. It does not validate Gatekeeper, signing, notarization,
Launch Services opening a pairing link, or a real user's macOS Keychain. The actual Mac/VPS
acceptance sequence below is still required.

## What this does not prove

The token store uses an AES-GCM fixture secret-storage implementation. This tests persistence
and the production store's storage boundary, **not macOS Keychain or Electron safeStorage**.
The tests run production transport source under Node/Vitest, not the packaged Electron UI.
Loopback HTTP is an allowed direct-address transport; this is not a public HTTPS deployment or
TLS certificate issuance test. The ephemeral SSH fixture does not prove a user's SSH agent or
provider firewall is configured correctly.

Before declaring a macOS-to-VPS release validated, run this manual acceptance sequence on an
actual Mac with an authorized disposable Linux VPS:

1. Install the Linux server and service using the documented installer. Confirm the service is
   running and that the default server port is loopback-only. Reboot and confirm it starts again.
2. Verify the VPS SSH host fingerprint through the provider, connect in Terminal, and load the
   authorized SSH key into the Mac's SSH agent. Do not bypass host-key verification.
3. Generate an SSH pairing link on the VPS. Open it in the installed Mac app, review the target,
   pair, and confirm the remote connection is visibly selected.
4. Create a channel and verify its appearance in a second authorized client. Open an artifact.
5. Quit/relaunch the Mac app and reconnect without entering another code. Confirm Keychain-backed
   storage works and the renderer does not receive a token. Lock/unavailable Keychain must fail
   closed rather than storing plaintext.
6. Restart the VPS service while connected. Confirm the app shows loss of connection, then use
   reconnect and verify the same workspace returns.
7. Use a separately generated URL pairing link through an authorized HTTPS reverse proxy or
   Tailscale Serve HTTPS connection. Confirm non-loopback HTTP (including Tailscale IPs/names) is rejected. Repeat the RPC/artifact/reconnect checks. An untrusted TLS certificate
   must not be bypassed.
8. Revoke the Mac device on the VPS. Confirm RPC and reconnect fail, and a fresh one-use pairing
   link is required. Confirm tokens are absent from the app/server logs.
9. Pair a second independent VPS as Work while the first is Personal. Use the same conversation
   ID in both test workspaces. Leave different text/image drafts in Local, Personal and Work;
   switch between them, confirm each draft returns only to its own environment, and verify
   the permission warnings name the server account. Check a pending send or image conversion
   cannot be silently discarded by switching. Review an uncertain send before retrying.
10. Exercise service stop/start/update and uninstall using disposable data, including a custom
    TUCANO_DATA path. Verify the documented retention behavior before deleting anything.

Automated local success is evidence for the protocol and SSH implementation, not a substitute
for those macOS packaging, Keychain, service boot, public-network, and real-deployment checks.
