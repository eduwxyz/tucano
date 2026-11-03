# Private desktop on a Linux VPS

Tucano servers remain headless by default. The browser and Docker computers keep
working independently. To let agents use Linux desktop apps, opt in with the
installer's `--desktop` option after preparing the prerequisites. This does not
control applications on the Mac used to connect to the VPS.

## Prerequisites

Use a dedicated **non-root Linux service account** with its own writable HOME.
An administrator must first install Xvfb, xvfb-run, xauth, dbus-run-session,
Openbox, setsid, xdpyinfo, an AT-SPI accessibility service, and the desktop apps
you want. Install `agent-desktop@1.0.2` on that account's PATH. Package names vary
by distribution (on Debian, xdpyinfo comes from x11-utils and AT-SPI from
at-spi2-core). The launcher does not install software or change system settings.

Check without starting a session:

```sh
/path/to/tucano/scripts/server-desktop.sh --check
```

Launch under that account (the installer configures the service for you):

```sh
/path/to/tucano/scripts/server-desktop.sh /absolute/path/to/node /path/to/tucano/out/main/server.js
```

The launcher creates a private authenticated Xvfb display with X11 TCP disabled,
a D-Bus session and Openbox. Its working directory is `~/tucano-workspace`.
It does not create VNC listeners or publish any new network ports. Keep Tucano's
HTTP endpoint on loopback and connect through the authenticated SSH pairing flow.
On shutdown, the launcher cleans up its child process group; when managed by
systemd, keep `KillMode=control-group` so even detached application processes are
removed with the service.

## Diagnostics and boundaries

The Apps card reports disabled desktop, missing graphical session, missing helper,
or AT-SPI/accessibility failure. Enabling `TUCANO_SERVER_DESKTOP=1` alone is not
enough: Linux, a local DISPLAY, a Unix D-Bus session and agent-desktop are required.
Use the launcher rather than borrowing another user's graphical session.
After installing a missing prerequisite, restart the service and choose **Check
again**. Apps must expose an accessibility tree; not every Linux app does.

Grant each agent only its needed apps, with read-only or read/write permissions.
Existing app approval checks remain in effect. This is a shared desktop for one
VPS account, not a per-agent security sandbox, and the accessibility integration
is not a streamed full-desktop/VNC viewer. The existing browser and Docker computer
views remain the visual takeover surfaces.

For personal and work environments, use separate VPSs, service accounts, HOME,
TUCANO_DATA, credentials, pairing tokens and backups. Pair both as separately named
remote environments. Selecting one changes where agents and these apps run; it
does not copy agents or credentials between VPSs. Never point two environments at
the same data directory or reuse their secrets to simulate isolation.

## Verification

`npx vitest run test/server-desktop.test.ts` uses only mocked prerequisite tools
and temporary HOME directories. For an opt-in real Linux check, first prepare
all prerequisites, build, then run `node scripts/server-desktop-e2e.mjs` as a
non-root user. It starts the real launcher and checks accessibility plus the
server's authenticated Apps RPC with disposable HOME/data. Desktop apps CI runs
this smoke check in addition to the existing real editor read/write test.
