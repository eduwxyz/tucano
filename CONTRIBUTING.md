# Contributing to Tucano

Thanks for wanting to help. Tucano is a small codebase on purpose: an Electron app, a core process with SQLite, and the coding-agent CLIs people already use. This guide gets you from clone to pull request.

## Setup

You need macOS on Apple silicon, Node 24 or later, and at least one harness signed in (`claude auth login` is the quickest).

```bash
git clone https://github.com/eduwxyz/tucano.git
cd tucano
npm install
npm run dev
```

`npm run dev` opens the app with hot reload, on its own data folder (`~/Library/Application Support/Tucano Dev`), so it never touches an installed Tucano.

Handy environment variables:

| Variable | What it does |
|---|---|
| `TUCANO_DATA=<dir>` | Use another data folder (a fresh install, a copy to test against) |
| `TUCANO_FAKE_ENGINES=1` | Agents answer with a scripted fake engine: no subscription, no tokens. Comes with a sample team |
| `TUCANO_SEED=0` | With fake engines, start empty instead of with the sample team |
| `TUCANO_LOCALE=en-US` | The system language a new install starts in |

To try connectors without any account, add the demo server in **Connectors → Add → Local → "Fill in with the demo server"** (`scripts/demo-mcp-server.mjs`, a local task list).

## Checks

```bash
npm run typecheck
npm test
```

Both must pass, and GitHub runs them (plus the build) on macOS and Linux for every pull request. Tests cover the core: the CLI stream parsers (with recorded outputs), context building, runs, limits, governance, routines, memory, the migration from the old name. A change in the core comes with a test.

For UI changes, attach a screenshot to the pull request. `node scripts/screens.mjs <folder>` opens the built app with Playwright on a temporary database and saves screenshots of the main screens.

## How the code is laid out

```
src/
  main/       Electron main process: the window, notifications, the agents' browsers, the Keychain
  core/       Utility process: SQLite, harnesses, runs, the MCP gateway, connectors, memory, routines
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
- **Small and direct.** Prefer the simple version that works over infrastructure for cases that don't exist yet. New dependencies need a reason.
- **Commits** are small and focused, with a message in the imperative ("Add …", "Fix …").

## Pull requests

1. Open an issue first for anything bigger than a fix, so we can agree on the approach.
2. Branch from `main`, keep the change focused, and make sure typecheck and tests pass.
3. Describe what changed and how you checked it.

## Reporting bugs

Open an issue with your macOS version, the Tucano version (**About Tucano**), the harness and model involved, and the steps to reproduce. A screenshot of the conversation, with each step expanded, helps a lot.

For security issues, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
