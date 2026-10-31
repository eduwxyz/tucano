# Tucano on Windows

Tucano was built for macOS. This document covers running it on Windows: what you need, how to run and package it, how it behaves differently from the Mac, and **every change** made to get there, file by file.

Status: runs on Windows 10/11 (x64), in development (`npm run dev`) and as an installed app, from each release (see [Installing](#installing)). Typecheck and the full test suite pass on Windows, including the Docker tests, and run on Windows for every pull request. A real agent turn through Claude Code works end to end. The Windows build is **not code-signed**. WSL 2 is an optional execution target; its end-to-end integration still needs validation on a Windows + WSL 2 machine.

## What you need

| | |
|---|---|
| Windows 10 or 11, x64 | Tested on Windows 10 Home 22H2 (19045) |
| [Node.js](https://nodejs.org) 24+ | For `npm install` and the tests |
| [Git for Windows](https://git-scm.com/download/win) | For Windows execution, its **Git Bash** runs local agent commands (Claude Code on Windows needs it too). Without it, those commands fall back to `cmd.exe`; WSL execution uses the selected distro's Bash instead |
| At least one harness, signed in | Claude Code is the quickest: `irm https://claude.ai/install.ps1 \| iex`, then `claude auth login`. Codex, Gemini CLI, OpenCode and Pi install with npm (`npm install -g @openai/codex`, `npm install -g @google/gemini-cli`, `npm install -g opencode-ai`, `npm install -g @earendil-works/pi-coding-agent`) |
| Optional: [Windows Terminal](https://aka.ms/terminal) | Opens the interactive harness sign-in flow for WSL; without it, Tucano shows the command to run yourself |
| Optional: [Docker Desktop](https://www.docker.com/products/docker-desktop/) | For the isolated Linux computer. The first use pulls `node:22-bookworm` |
| Optional: Google Chrome | For an agent's browser; it is found in `Program Files`, `Program Files (x86)` or `%LOCALAPPDATA%` |
| Optional: WSL 2 | Runs all five supported harnesses and the “this computer” tools in one selected Linux distribution; WSL 1 is not supported |

## Running agents in WSL 2

Tucano remains a Windows app: its window, database, tray, and Windows-protected secrets stay on Windows. In **Settings → General → Agent execution**, choose **WSL 2** and a distribution. Tucano preselects WSL's default WSL 2 distribution when enabling it; you can choose another installed WSL 2 distro later. Windows remains the default until you opt in.

To install Ubuntu from an elevated PowerShell, run `wsl --install -d Ubuntu`, restart if Windows asks, then check `wsl --list --verbose`. The distro's **VERSION** must be `2`; upgrade an existing distro with `wsl --set-version <name> 2`.

Install the harnesses **inside that distribution**, and sign in there. Claude Code, Codex, Gemini CLI, OpenCode (v1 and v2), and Pi are detected and launched in WSL; changing the selected distro triggers a fresh harness check, and each distro has its own installations and logins. When Windows Terminal is installed, the app's login button opens it in the chosen distro. Codex and OpenCode keep Tucano's isolated app data separate from the user's project/config files. A selected distro that is missing or no longer WSL 2 is reported as unavailable; Tucano does not silently fall back to Windows.

All local agent commands, services, and file tools use the selected distro. Local stdio MCP connectors added while WSL is selected also run in that distro; existing Windows stdio connectors keep running on Windows. A Windows project such as `C:\Users\you\code\app` is available there as `/mnt/c/Users/you/code/app`. A project in the distro's Linux filesystem can be addressed from Windows through `\\wsl.localhost\<distro>\home\you\code\app`, or by its Linux path in an agent tool. Tucano's own app data remains under `%APPDATA%\Tucano`.

Tucano first checks whether the distro can reach its gateway through `127.0.0.1` (available with mirrored networking). If not, it falls back to a second listener bound only to the Windows vEthernet address visible to that distro; it never binds the gateway to every interface. The fallback can trigger a Windows Firewall prompt on first use—allow access only on private networks. Windows-to-WSL service access uses WSL 2's localhost forwarding. If agent tools cannot connect, confirm that the distro is WSL 2 and its networking is enabled. The distribution may be stopped; WSL starts it when needed.

The regular Windows path still runs commands in Git Bash (or `cmd.exe` without Git for Windows). Selecting WSL changes only the agent execution target, not Windows shortcuts, notifications, Chrome, or the isolated Docker computer.

### WSL 2 release smoke test

Before calling WSL support validated, use a Windows 11 machine with a WSL 2 distro and install/sign in to **Claude Code, Codex, Gemini CLI, OpenCode, and Pi inside that distro**. Check each harness and send a test reply; run Claude Code and Codex turns that call tools through the gateway; and import and call a local stdio MCP server. Exercise both a Windows-drive project and a project under the distro's `/home`, file read/write and `show_file`, and a prompt long enough to exercise the private temporary-file path. Stop a turn mid-run and confirm no process is left running in the distro. Switch back to Windows and confirm Windows harnesses and Windows-targeted connectors still work.

## Installing

```powershell
irm https://github.com/eduwxyz/tucano/releases/latest/download/install.ps1 | iex
```

`install.ps1` downloads the release's `tucano-win-x64.exe` and runs it silently (`/S`): a one-click NSIS installer that puts Tucano in `%LOCALAPPDATA%\Programs\tucano`, for the current user, with no admin rights, and lists it in **Installed apps**. Then it opens the app. An open Tucano is asked to quit first (`Tucano.exe --quit`, which quits it the way its tray menu does); data in `%APPDATA%\Tucano` is never touched, and uninstalling leaves it too.

The installer isn't code-signed, and that's a choice for now. A file downloaded by a browser carries the "from the internet" mark (Mark of the Web), and SmartScreen warns before an unsigned one runs (**More info › Run anyway**), once per version. A file PowerShell downloads doesn't carry it, so the command above never shows the warning. Company PCs may block unsigned apps altogether, by policy.

`install.ps1` is ASCII only: Windows PowerShell 5.1 reads a download with no charset (GitHub serves release files as `application/octet-stream`) as Latin-1, so the Portuguese messages are written with `\u` escapes. Everything runs inside a script block that catches its own errors, since `exit` would close the window `iex` runs in. `TUCANO_EXE` (a URL or a file) installs another build, for testing, and then doesn't open it.

### Updates

Each release carries `latest.yml`, the Windows update feed, next to the installer and its `.blockmap`. The installed app reads it (`src/main/updates.ts`), downloads a new version in the background and shows **Restart**; restarting runs the installer silently and opens the new version (`quitAndInstall(true, true)`). Without a restart, it goes in the next time the app quits. electron-updater checks the installer's signature only when the app was signed (`publisherName`), so an unsigned build updates as a signed one would, and the download carries no Mark of the Web.

### How a release gets the Windows files

`scripts/release.sh` (on the Mac) creates the release with the Mac files, `install.sh` and `install.ps1`. Publishing it starts `.github/workflows/windows.yml` on `windows-latest`, which builds the installer, installs it with `install.ps1` as a check, and attaches `tucano-win-x64.exe`, its blockmap and `latest.yml` to the release, a few minutes after it's out. `workflow_dispatch` with a tag does the same for an existing release. A pull request that touches the packaging or `install.ps1` runs the build and the install check without publishing.

## Running it

```powershell
git clone https://github.com/eduwxyz/tucano.git
cd tucano
npm install
npm run dev
```

- **Electron's binary.** Electron 44 downloads its binary the first time it runs, not at `npm install`. If `npm run dev` stops on that (offline, proxy), run `node node_modules/electron/install.js` once.
- **Data folder.** `npm run dev` keeps its data in `%APPDATA%\Tucano Dev`; the installed app uses `%APPDATA%\Tucano`. `TUCANO_DATA`, `TUCANO_FAKE_ENGINES=1` and `TUCANO_SEED` work as on the Mac (in PowerShell: `$env:TUCANO_FAKE_ENGINES = '1'; npm run dev`).
- **Checks:** `npm run typecheck` and `npm test`. The Docker tests run when Docker Desktop is running and `node:22-bookworm` is pulled; otherwise they are skipped.
- **Screenshots:** `node scripts/screens.mjs <folder>` works as on the Mac.

### Packaging

```powershell
npm run dist:win
```

This builds `dist\tucano-win-x64.exe`, the same one-click per-user installer the releases carry. `npx electron-builder --win --dir --x64` builds just the unpacked app, in `dist\win-unpacked\Tucano.exe`. `$env:TUCANO_EXE = 'dist\tucano-win-x64.exe'; .\install.ps1` installs a local build the way people will. `npm run dist`, `npm run install-app` and `npm run release` remain macOS-only (Apple signing, notarization, `/Applications`); releases get the Windows files from GitHub Actions (above).

## How it behaves differently from the Mac

| | macOS | Windows |
|---|---|---|
| Finding harness CLIs | The login shell's `PATH` (apps opened from Finder get a minimal one) | The process `PATH` as is (Windows gives every app the full one), trying each `PATHEXT` extension: `claude.exe`, `codex.cmd`… |
| Running a CLI | Spawned directly | `.exe` spawned directly; an npm `.cmd` shim is read and its target run directly (`node <package>\cli.js`, or the package's `.exe`); any other `.cmd`/`.bat` through `cmd.exe`, with every argument escaped for it, refusing a multi-line argument (Node refuses to spawn a `.cmd` directly) |
| Stopping a CLI or command | `SIGTERM`/`SIGKILL` to the process group | `taskkill /t /f` on the process tree, plus the MSYS process group (see below) |
| *This Mac / This PC* computer | `/bin/bash`, the login shell's environment | Git's MSYS `bash.exe` (with `MSYSTEM` and the Git tools on `PATH`, as Git Bash's launcher sets them), the app's environment minus `TUCANO_*`, `ELECTRON_*`, `VITE_*` and `NODE_OPTIONS`; `cmd.exe` if Git isn't installed. The agent's tool description and system prompt say which shell it is |
| Folders that can't be lent | `~/Library`, dot folders | Also `%USERPROFILE%\AppData` |
| Signing in to a harness | Opens Terminal.app via `osascript` | Opens a console window running a small `login.cmd` in the data folder |
| `apiKeyHelper` (Claude Code on a gateway) | Runs in the login shell (`$SHELL -lc`) | Runs in Git Bash, or `cmd.exe` |
| Sounds | `afplay` | PowerShell's `Media.SoundPlayer` |
| Notifications | Native | Native toasts (needs the app id `dev.tucano.app`, set at start) |
| Menu | App menu (About, Services, Hide, Quit), Edit, View, Window | File (About, Exit), Edit, View, Window |
| Shortcuts | ⌘K, ⌘N, ⌘1…9, ⌘, | Ctrl+K, Ctrl+N, Ctrl+1…9, Ctrl+, (and the labels say so) |
| Install hints for missing harnesses | `curl … \| bash` in Terminal | `irm … \| iex` / `npm install -g …` in PowerShell |
| Moving data from *agent-desk* | On first open of the installed app | Skipped: agent-desk never shipped for Windows, and the key lived in the macOS Keychain |
| Secrets | Keychain (Electron `safeStorage`) | DPAPI (Electron `safeStorage`), no change needed |
| Closing the window | The app stays in the Dock; routines go on | The app stays in the tray, by the clock, as on Linux; routines go on, a notification says so once, and the tray icon reopens the window or quits |

### Why npm shims don't go through `cmd.exe`

Claude Code and Pi get the system prompt as an argument (`--system-prompt`), many lines long, and the flags that keep them isolated (`--no-builtin-tools`, `--offline`, `--strict-mcp-config`…) come after it. `cmd.exe` ends a command at a line break, with or without quotes or carets, so through `cmd.exe` those flags were silently dropped and the CLI ran with its own tools and config: everything Tucano governs. Pi installed with npm is always a `.cmd`, and so is Claude Code installed with `npm install -g`. npm's shims all end in `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`, so `spawnable` reads the target and runs it itself, and `cmd.exe` never sees the arguments. A `.cmd` that isn't such a shim still goes through `cmd.exe`, and a multi-line argument for it is refused rather than truncated.

### Why Git Bash runs without its launcher, and the MSYS process group

`C:\Program Files\Git\bin\bash.exe` is a small launcher that starts the real shell, `usr\bin\bash.exe`. Tucano starts the real one directly, with the environment the launcher would set: `MSYSTEM` is `UCRT64` on recent Git installs (or `MINGW64`), and `<git>\ucrt64\bin` (or `mingw64\bin`) and `<git>\usr\bin` go first on `PATH`. That way the pid Tucano holds is the shell's own.

That matters for stopping commands. Git Bash emulates `fork`, so a job sent to the background (`npm run dev &`, `sleep 30 & …`) ends up with a Windows parent that has already exited. `taskkill /t` can't find it from the shell, and the orphan keeps the output pipe open, so a timed-out command would never return. MSYS still keeps its own process groups, so before calling `taskkill`, Tucano runs Git's `ps` and adds the Windows pid of every process in the shell's group. `test/mac.test.ts` ("stops a command at its time limit, with its children") covers this, and no `sleep` is left behind afterwards.

### Docker on Windows

The Linux computer works unchanged, including lending a Windows folder (`-v C:\Users\…\project:/projetos/project`) and `host.docker.internal`. The one difference is a Docker CLI bug: on Windows, `docker cp -L` resolves an absolute link target (`/etc/hostname`) against the link's own folder (`/work/etc/hostname`), so showing a file through a symlink failed. On Windows, Tucano resolves the path inside the container first (`readlink -f`, which still can't reach the host) and copies the plain file.

## Every change

### New files

| File | What and why |
|---|---|
| `src/core/platform.ts` | The core's OS differences in one place (the file came with the Linux support; Windows adds to it). `executableNames` (`PATHEXT` names of a command, keeping only `.exe`, `.cmd`, `.bat` and `.com`, never `.js`/`.vbs`/`.py`); `pathDirs` (`PATH` split on `;`, whatever its spelling); `spawnable` (how to spawn a CLI: an npm/pnpm/yarn `.cmd` shim runs its target directly, with the shim's `node.exe` or the interpreter it names on `PATH`; any other `.cmd`/`.bat` goes through `cmd.exe /d /s /c` with cross-spawn's doubled escaping, and refuses an argument with a line break, since `cmd.exe` would end the command there and drop every argument after it); `killTree` (process group on POSIX; `taskkill /t /f` plus the MSYS process group on Windows); `gitRoot` (finds Git for Windows from `CLAUDE_CODE_GIT_BASH_PATH`, `PATH` or the usual install folders, never WSL's bash); `shellCommand` (the shell for an agent's command and the environment it needs). `chromeCandidates` also lists Chrome's Windows folders (`Program Files`, `Program Files (x86)`, `LOCALAPPDATA`), and `userAgentPlatform` says Windows 10 |
| `test/platform.test.ts` | Tests for `platform.ts`. On Windows: a real npm-style `.cmd` shim receives awkward arguments intact (quotes, `&`, `%PATH%`, `^`, `( ) \| < >`, trailing backslashes, spaces, the empty string, Codex's `-c` TOML values); a shim in npm's exact format runs its script directly, so a multi-line argument with `&` and `%PATH%` and the flags after it all arrive; a shim for a package's `.exe` runs the `.exe`; any other script refuses a multi-line argument; `PATHEXT` lookup, and Git's bash starts with the right `MSYSTEM` and `PATH`. On macOS and Linux: a CLI is spawned as is, and the shell is `/bin/bash`. On every system: Chrome's Windows folders and user-agent metadata. The test of the execute bit skips on Windows, which has none |
| `.gitattributes` | LF for every text file regardless of `core.autocrlf`. A Windows checkout with CRLF breaks `install.sh` and `scripts/*.sh` in bash and makes diffs noisy |
| `docs/windows.md` | This document |

### Core (`src/core`)

| File | Change | Why |
|---|---|---|
| `engines/detect.ts` | `adoptLoginShellPath` does nothing on Windows; `which` uses `pathDirs()` and `executableNames()`; `run` goes through `spawnable` with `windowsHide` | The login-shell trick (`$SHELL -ilc`) has no Windows equivalent and isn't needed; `PATH` is `;`-separated there; the CLIs are `claude.exe`, `codex.cmd`…; `execFile` can't run a `.cmd` |
| `engines/opencode-v2.ts` | `opencode serve` and `opencode session …` spawn through `spawnable`; a stop on Windows kills the tree. Its process tests use a `#!/bin/sh` fake, so they skip on Windows | As in `cli.ts`: `opencode` is an npm `.cmd` on Windows |
| `engines/cli.ts` | `runCli` spawns through `spawnable` with `windowsHide`; a stop on Windows kills the tree | A CLI may still sit behind `cmd.exe` (a `.cmd` that isn't an npm shim): `child.kill()` would end only `cmd.exe` and leave the CLI running |
| `mac.ts` | Commands and services run through `shellCommand` and stop through `killTree`; `detached` only on POSIX (on Windows it opens a console window); `loginEnv` on Windows is the app's environment without its own variables, with `HOME` added; `~\` paths resolve to the home folder; the `bash` tool's description names the Windows shell; a service's log tail splits on `\r?\n` | `/bin/bash`, negative-pid process groups and a login shell don't exist on Windows; the model has to know it is in Git Bash or `cmd.exe`, not macOS |
| `context.ts` | When the agent's computer is this PC, the "Your computer" intro names Windows (`systemName()`) and which shell (`C:\Users` is `/c/Users` in Git Bash); installing system-wide names `winget` instead of `apt`/`brew` | Same reason: the model writes the commands |
| `computer.ts` | `checkFolder` also refuses `AppData`; on Windows `keep` resolves a container path with `readlink -f` before `docker cp` | `AppData` is Windows' `Library` (settings, credentials). The `docker cp -L` bug is described above |
| `connectors.ts` | Not Windows-specific, found while testing here: a remote connector added with OAuth whose server has no dynamic client registration (GitHub's `api.githubcopilot.com/mcp/`) now says to add it again with a token, instead of the SDK's "Incompatible auth server: does not support dynamic client registration". Test: `test/connectors.test.ts` | GitHub's OAuth only serves apps registered ahead of time, so a personal access token is the way in; the raw SDK message didn't say what to do |
| `chrome.ts` | Nothing: `findChrome()` and `userAgentPlatform()` in `platform.ts` answer for Windows too | Chrome lives in `Program Files` on Windows; sites compare the client hints with the user agent string, which says Windows there |
| `mac.ts`, `computer.ts`, `context.ts`, `team.ts` | Nothing in the copy: since the Linux support every message says "this computer" and names the system with `systemName()` | The model and the person never read "Mac" on a PC |
| `skills.ts` | A linked skill's folder uses `dirname(source)`, and its name `basename(dirname(source))` | `source.lastIndexOf('/')` / `split('/')` broke on `C:\…\SKILL.md`: the support files weren't listed and the fallback name was wrong |
| `local-skills.ts` | Support files are listed with `/` | So the listing the model reads (`refs/a.md`) is the same on both systems; reading it back works with either separator |
| `index.ts` | `runHelper` (`apiKeyHelper`) uses `shellCommand` on Windows; `loginEngine` on Windows writes `login.cmd` in the data folder and opens it in a new console (`start "Tucano" cmd.exe /k`), setting `HOME` and `CODEX_HOME` for Codex, and answers `opened: true` (`terminalCommand` has no terminal for Windows) | `osascript` and Terminal.app don't exist; a script avoids `cmd.exe`'s quoting rules for paths with spaces |

### Main process (`src/main/index.ts`)

| Change | Why |
|---|---|
| `app.setAppUserModelId('dev.tucano.app')` on Windows | Windows shows toast notifications only for an app with an id; it matches the installer's `appId` |
| The agent-desk migration runs only on macOS | It calls `/usr/bin/security` and moves a macOS Keychain key; agent-desk never existed on Windows |
| The sound `player` on Windows is PowerShell's `Media.SoundPlayer` | `afplay` is macOS-only; this needs nothing installed |

### Window (`src/renderer`)

Shortcuts (Ctrl off a Mac), their labels (`shortcut(platform, key)`), the menu and the copy ("this computer", "the system's vault") already come from the Linux support, which reads the system from `snapshot.platform` (`windows` here).

| File | Change |
|---|---|
| `components/Harness.tsx` | "Paste in PowerShell", with the Windows install command when there is one |
| `components/Splash.tsx` | Not Windows-specific, found while running here: in dev, StrictMode runs the splash effect twice, and the second run couldn't parse the leaves' `translate(…)` after GSAP had rewritten it, which crashed the window. Each leaf's position is now kept in a `data-at` attribute the first time it's read |
| `src/shared/types.ts` | `ENGINES[…].windows`: the PowerShell install commands for Claude Code (`irm https://claude.ai/install.ps1 \| iex`) and OpenCode (`npm install -g opencode-ai`) |

### Tests (`test`)

| File | Change |
|---|---|
| `mac.test.ts` | Platform-aware where the platform really differs: `pwd -W` in Git Bash prints `C:/…`; a Windows absolute path for the "absolute path" case; the injected environment carries Windows' `PATH` and `SystemRoot`; the service test serves with `node` (on Windows `python3` is often the Store's placeholder); on Windows no tool description or prompt line may say *Mac*, and the prompt names Git Bash or `cmd.exe`; `PATH` is looked up whatever its spelling. On macOS every expectation is the same as before |
| `engines.test.ts` | `CODEX_HOME` is compared with `join(…)` instead of a hard-coded `/` path |
| `computer.test.ts` | The `.venv` existence stub matches with `join(…)` |

### Build and repo

| File | Change |
|---|---|
| `package.json` | `build.win` (NSIS, `build/icon.png`, `tucano-win-${arch}.${ext}`), `build.nsis` (one-click, per user) and the `dist:win` script |
| `README.md`, `README.pt-BR.md` | A `npm run dist:win` row, and a "On Windows?" note pointing here |
| `CONTRIBUTING.md` | Windows in Setup (and its dev data folder), and a convention: OS differences live in `platform.ts`, paths go through `path`, commands through `spawnable`/`shellCommand` |

## What was verified, on Windows 10 (19045), Node 24.20, Electron 44.8

- `npm run typecheck`: clean.
- `npm test`: every test passes, including the 17 Docker tests with Docker Desktop 29.6 running. Without Docker running, those are skipped, as on the Mac.
- `npm run build`, then `scripts/screens.mjs` with the fake engines, through screen 24 of 27: channels, router, handoffs, `ask_user`, connectors with the demo MCP server, grants, approvals, memory, summaries, and the Linux computer in Docker with a lent command, a service on port 8000, a screenshot and the side panel. The last steps (routines) fail on every system: their selectors (`.routine-example`, `.routine-form`) predate the calendar redesign of the Routines page. The routine engine is covered by `test/routines.test.ts`.
- One real turn with Claude Code 2.x (`claude.exe`): detected and signed in, the agent replied through the per-turn MCP gateway, receipt included.
- The packaged app (`electron-builder --win --dir`): starts, finds its bundled sounds, has the Windows menu, and Ctrl+K opens *Go to*.

And on macOS, to check nothing changed there: the same branch on GitHub Actions' `macos-latest` (macOS 26.6, Apple silicon, Node 24.21). `npm run typecheck` is clean. `npm test` reports 227 passed and 11 skipped: the Docker tests (no Docker on that runner) and the three Windows-only ones in `platform.test.ts`. `mac.test.ts` runs in full there, with the real `/bin/bash`. `electron-builder --mac --dir` packages an ad-hoc signed `Tucano.app` that passes `codesign --verify --deep --strict` and keeps running. `scripts/screens.mjs` (with `TUCANO_LOCALE=pt-BR`, since its selectors are in Portuguese) gets through 19 screens, up to the Linux computer, which needs Docker.

## Known limitations

- **Not code-signed.** The installer opened from a browser download gets a SmartScreen warning, once per version; `install.ps1` and updates don't. Company PCs may block it by policy.
- **x64 only.** Windows 11 on ARM runs it under emulation.
- **Two macOS-only dialogs** in `src/main/index.ts` (⌘Q, the macOS Keychain) still name the Mac: they belong to the agent-desk migration, which never runs on Windows.
- **Without Git for Windows**, agents on *This PC* get `cmd.exe`, and the model is told so. Claude Code itself needs Git Bash on Windows anyway.
- **WSL isn't used.** Agents' commands on this PC run in Git Bash, not in a WSL distribution. The isolated Linux computer is Docker's.
- **macOS-only scripts:** `scripts/dist.sh`, `scripts/install-app.sh` and `scripts/release.sh`. `install.sh` covers macOS and Linux; on Windows it points to `install.ps1`.
