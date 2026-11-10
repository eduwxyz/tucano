# Contributing to Tucano

Thanks for wanting to help. Tucano is a small codebase on purpose: an Electron app, a core process with SQLite, and the coding-agent CLIs people already use. This guide gets you from clone to pull request.

Development talk happens in `#contributing` on our [Discord](https://discord.gg/uQp4x7wUgT): a good place for quick questions or when you get stuck. Anything bigger than a fix still starts as an issue (see below).

## Setup

You need macOS on Apple silicon or Linux (x64 or ARM64), Node 24 or later, and at least one harness signed in: whatever you already pay for. The reference machine runs Pi with its `opencode-go` provider (DeepSeek 4.1 Flash), and nothing here assumes Claude Code — see [A testing checkout](#a-testing-checkout). Windows 10/11 works too, with Git for Windows installed: see [docs/windows.md](docs/windows.md).

For Arch Linux or CachyOS with Niri, see the [validation guide](docs/arch-linux.md), including the checks still needed for desktop integration.

```bash
git clone https://github.com/eduwxyz/tucano.git
cd tucano
npm install
npm run dev
```

`npm run dev` opens the app with hot reload, on its own data folder (`~/Library/Application Support/Tucano Dev`, or `%APPDATA%\Tucano Dev` on Windows), so it never touches an installed Tucano.

Handy environment variables:

| Variable | What it does |
|---|---|
| `TUCANO_DATA=<dir>` | Use another data folder (a fresh install, a copy to test against) |
| `TUCANO_FAKE_ENGINES=1` | Agents answer with a scripted fake engine: no subscription, no tokens. Comes with a sample team |
| `TUCANO_SEED=0` | With fake engines, start empty instead of with the sample team |
| `TUCANO_LOCALE=en-US` | The system language a new install starts in |
| `TUCANO_TEST_MODEL=<id>` | The core model a testing run uses, instead of the one the app picks: see [A testing checkout](#a-testing-checkout) |

To try connectors without any account, add the demo server in **Connectors → Add → Local → "Fill in with the demo server"** (`scripts/demo-mcp-server.mjs`, a local task list).

## Checks

```bash
npm run typecheck
npm test
```

Both must pass, and GitHub runs them (plus the build) on macOS, Linux and Windows for every pull request. Tests cover the core: the CLI stream parsers (with recorded outputs), context building, runs, limits, governance, routines, memory, the migration from the old name. A change in the core comes with a test.

For UI changes, attach a screenshot to the pull request. `node scripts/screens.mjs <folder>` opens the built app with Playwright on a temporary database and saves screenshots of the main screens.

### A testing checkout

Every checkout runs on the same model, and none of them assumes Claude. `test/testing.json` names it once — `pi:opencode-go/deepseek-v4.1-flash`, DeepSeek 4.1 Flash through Pi's `opencode-go` provider — and `scripts/pre-go.mjs` hands it to the core as `TUCANO_TEST_MODEL`. The core takes it as `routerModel` and `memoryModel` (who replies in a channel, and memory) and as the model of the demo team it seeds, so a run here has a model that actually answers. Unset, as on a real install, nothing changes: the app picks from what is signed in.

The suite itself spends nothing: it runs on fake engines, and each test makes its own `TUCANO_DATA` folder.

```bash
node scripts/pre-go.mjs                              # what a fresh checkout needs before it runs
node scripts/pre-go.mjs --check                      # is this checkout ready?
node scripts/pre-go.mjs --run npm run dev --data <d> # run something on the testing model
```

`pre-go` links `node_modules` to a checkout that already has an install (a junction on Windows, so a worktree tests in seconds instead of a second `npm ci`) and writes `.pre-go.json` recording the model it runs on. It installs nothing and touches nothing outside the checkout.

## How the code is laid out

```
src/
  main/       Electron main process: the window, notifications, the agents' browsers, the system's vault, the tray (Linux, Windows)
  core/       Utility process: SQLite, harnesses, runs, the MCP gateway, connectors, memory, routines
              (platform.ts holds what differs between macOS and Linux: ask it, don't check the platform)
  renderer/   React UI, talking to the core over a MessagePort
  shared/     Types, the RPC contract and the language helper, used by all three
test/         Vitest, for the core
scripts/      Build, release, screenshots, the demo MCP server
docs/         The original design spec (in Portuguese), images
site/         The website
```

No agent work runs in the window or the main process: everything goes through the core, and the core only gives a harness the tools of the agent it is running, through a per-turn MCP URL.

## Conventions

- **Language.** Code, comments, commit messages and pull requests are in English. The app speaks Portuguese and English: every string a person reads is written once in each, side by side, with `L('Português', 'English')` from `src/shared/lang.ts`. Don't put translated text in module-level constants (they're evaluated before the language is known): build it where it's used.
- **Comments** say why, not what, in plain sentences.
- **macOS, Linux and Windows.** What differs between them lives in `src/core/platform.ts` (finding and spawning CLIs, the agents' shell, stopping process trees, terminals, Chrome); the window reads the system from `snapshot.platform`. Use `path.join`/`dirname` for file paths, never `'/'` string handling, and run commands through `spawnable`/`shellCommand` rather than spawning `/bin/bash` or a bare `.cmd`.
- **Small and direct.** Prefer the simple version that works over infrastructure for cases that don't exist yet. New dependencies need a reason.
- **Commits** are small and focused, with a message in the imperative ("Add …", "Fix …").

## Pull requests

1. Open an issue first for anything bigger than a fix, so we can agree on the approach.
2. Branch from `main`, keep the change focused, and make sure typecheck and tests pass.
3. Describe what changed and how you checked it.

## Reporting bugs

Open an issue with your system and its version (macOS, or the Linux distribution and desktop), the Tucano version (**About Tucano**), the harness and model involved, and the steps to reproduce. A screenshot of the conversation, with each step expanded, helps a lot.

For security issues, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
