# Arch Linux and CachyOS with Niri

This guide covers running Tucano on Arch Linux and its family, and repeating the validation in a Niri/Wayland session. The run recorded below was done on CachyOS. It covers the source code and a basic Electron start; installing from the AppImage and full desktop integration still need testing.

## Installing the AppImage

Download the AppImage for your architecture from the [releases page](https://github.com/eduwxyz/tucano/releases). For x86_64, the 0.2.0 file is `tucano-linux-x86_64.AppImage`; for ARM64, `tucano-linux-arm64.AppImage`.

In the download folder, for x86_64:

```bash
chmod +x tucano-linux-x86_64.AppImage
./tucano-linux-x86_64.AppImage
```

If it fails with a FUSE error, check that `fuse2` is installed (`pacman -Q fuse2`). The package is in the Arch Linux repositories. Don't run the app as root or turn off the sandbox to get around a start-up failure.

`install.sh` also picks the AppImage on systems without apt/dpkg and adds an entry to the applications menu. On Arch, don't use the `.deb`. Installing and updating the AppImage was not run in this validation.

## The validated environment

Validated on 2026-10-30, on the 0.2.0 code with this contribution's Ghostty support:

| Component | Version or value observed |
|---|---|
| Distribution | CachyOS, rolling, `ID_LIKE=arch` |
| Architecture | x86_64 |
| Session | `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=niri` |
| Niri | 26.04 |
| Ghostty | 1.3.1-arch2.2 |
| Kitty | 0.49.2 |
| Alacritty | 0.17.0 (94e7c887) |
| Node.js | 24.16.0 |
| npm | 11.16.0 |
| Electron | 44.8.0 |
| FUSE | `fuse2` 2.9.9-6 installed, AppImage not tested |

To record another environment, use `cat /etc/os-release`, `uname -m`, `niri --version`, `ghostty --version`, `kitty --version`, `alacritty --version`, `node --version` and `npm --version`. Record the session type and the desktop too, without publishing the full contents of the environment variables.

## Checks run

In the checkout, with Node.js 24 or later:

```bash
npm ci
npm test -- test/platform.test.ts
npm run typecheck
npm test
npm run build
```

Results observed:

| Check | Result |
|---|---|
| Platform tests | 22 passed, 6 skipped by platform |
| Typecheck | Passed |
| Full suite | 32 files passed; 261 tests passed, 14 skipped |
| Build | Passed |
| Ghostty, opened for real with what `terminalCommand` returns | Command ran, marker in a temporary file confirmed |
| Kitty, opened for real with what `terminalCommand` returns | Command ran, marker in a temporary file confirmed |
| Alacritty, opened for real with what `terminalCommand` returns | Command ran, marker in a temporary file confirmed |
| Electron with `--ozone-platform=wayland` | Window visible, `.sidebar` present, no `pageerror` event in the basic test |
| Notifications API | `Notification.isSupported()` returned `true`; delivery not tested |
| Electron's keyring | `isEncryptionAvailable()` returned `false`, backend `basic_text` |

Skipped tests don't count as verified features. There was no real sign-in and no tokens spent: the start used `TUCANO_FAKE_ENGINES=1` and temporary data. The graphical test doesn't cover every flow of the interface.

### Ghostty, Kitty and Alacritty

On Linux, Ghostty and Alacritty take `-e` followed by the program and its arguments; Kitty takes the program directly. Tucano passes `sh`, `-c` and the sign-in command as separate arguments and keeps the shell open after the command, as with the other Linux terminals. Desktop terminals already earlier in the list still win when they are installed too.

Kitty and Alacritty were already supported. This contribution adds Ghostty and regression tests for the three terminals, including executable paths with spaces and the preference for the desktop's terminal. The choice follows the order of Tucano's list; it doesn't look up which terminal the session has set as its default.

To run the command Tucano produces for real in each of the three installed terminals, at the root of the checkout:

```bash
node --input-type=module <<'NODE'
import { terminalCommand } from './src/core/platform.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const bin of ['ghostty', 'kitty', 'alacritty']) {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-terminal-'))
  try {
    const marker = join(dir, 'result')
    const terminal = terminalCommand(`printf '%s' 'ok' > '${marker}'`, 'linux', candidate => candidate === bin)
    if (!terminal) throw new Error(`${bin} was not selected`)
    const result = spawnSync(terminal.bin, terminal.args, {
      env: { ...process.env, SHELL: '/bin/true' },
      timeout: 15000
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${bin} exited with ${result.status}: ${result.stderr}`)
    if (readFileSync(marker, 'utf8') !== 'ok') throw new Error(`${bin} marker check failed`)
    console.log(`${bin} check passed`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
NODE
```

`SHELL=/bin/true` applies only to the test's process and closes the window after the command runs. Keeping the interactive shell open is covered by the argument composition in the unit test; using that shell by hand and the OAuth sign-in still need validation.

## Desktop checks still to do

After `npm run build`, open a separate instance with temporary data and simulated agents. Quit the app from its menu before deleting the temporary folder:

```bash
validation_data=$(mktemp -d)
TUCANO_DATA="$validation_data" TUCANO_FAKE_ENGINES=1 \
  ./node_modules/.bin/electron . --ozone-platform=wayland
rm -r -- "$validation_data"
```

| Area | What to check |
|---|---|
| Keyring | Confirm a Secret Service or KWallet is available and unlocked in the session; check that Electron picks a secure backend before trying to store a throwaway credential |
| Noctalia tray | Confirm the icon shows, the window reopens after closing it, and quitting from the tray menu works |
| Notifications | Confirm delivery, the click, and the return to the conversation |
| Terminals and sign-in | Ask for the sign-in from the interface, finish it with a harness and check the return to Tucano; repeat with each terminal to validate |
| Open at login | With a persistent install, turn the option on and check `~/.config/autostart/tucano.desktop` (or the `XDG_CONFIG_HOME` folder); then test a new login to the session |
| AppImage | Check that it opens, the applications menu, the packaged resources, and updating |

`gnome-keyring` was installed in the tested environment, but that wasn't enough to make encryption available to Electron. Tucano refuses to store credentials with `basic_text` or without encryption available. Don't force that backend to get around the protection, and don't use real credentials while the keyring isn't working.

Tucano writes an XDG entry for opening at login on Linux. Whether it runs depends on the Niri session's setup. Don't turn on Open at login from the checkout or from the temporary instance above: the development executable isn't a persistent install.

When reporting a result, include Tucano's version or commit, the distribution, the compositor, the terminal, how it was installed, the steps run and the expected and observed result. Don't include tokens, credentials or logs you haven't reviewed.
