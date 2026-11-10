# An outside reviewer on every pull request

*An informal proposal. This page is the whole of the pull request: nothing is installed, enabled or
required by it, and the only other change is one line in `CONTRIBUTING.md` pointing here. Delete it if
the idea doesn't fit.*

## The gap

Tucano's checks are honest, and they're blind in a specific way. `npm run typecheck` and `npm test` on
macOS, Linux and Windows catch what a test asserts. They cannot catch:

- a check-then-use between two awaits;
- a field crossing the renderer → core IPC boundary without being validated on the far side;
- a SQL string built by hand in a place a parameter would do;
- a path joined with a name that came from a model, a web page or a connector;
- a token or an API key reaching a log line;
- a test that asserts the bug (it passes, and it will keep passing).

And in this repository the reviewer and the author are usually the same thing: most PRs here are
written by an agent and merged by the person who asked for them, often in the same afternoon. The same
model reading its own diff is not a review — it's a second guess with the same blind spots. Tucano
hands agents tools, a shell and a browser, so the security-shaped mistakes are the expensive ones, and
they're exactly the ones a test suite is worst at.

## Two bots that read the diff

Both install as a GitHub App, both comment on the pull request itself, both are free for public
repositories. They're not alternatives to CI; they're the reader CI doesn't have.

### CodeRabbit

- Per PR: a plain-language summary and walkthrough, line-level findings, one-click fixes, pre-merge
  checks, and *slop detection* for AI-written pull requests — useful in a repo where most PRs arrive
  from an agent.
- Its entry plan already includes **Secure**: static analysis, secrets, dependency and
  infrastructure-as-code checks on the diff.
- **Cost here: nothing.** Public repositories get free reviews forever, with no extra setup — install
  the app on the repo and that's the plan you're on.
- Paid plans, if this ever stops being a public OSS repo: Essentials $24/dev/month billed annually
  ($30 monthly), Team $48 ($60), Advanced $72.
- <https://www.coderabbit.ai/pricing>

### Sourcery

- Reviews every PR within minutes: a summary, inline review comments, and suggested changes you can
  commit from the GitHub UI. It's aimed at logic errors, missed edge cases and security issues rather
  than style.
- Can auto-approve a low-risk PR with no blocking findings, which is a nice fit for the small,
  single-purpose PRs this project already gets.
- Security scanning on changed code, plus scheduled scans for exposed secrets, vulnerable code,
  misconfigured infrastructure and dependencies with known CVEs.
- Every language GitHub recognises, **TypeScript included**. Keeps no copy of the code after a review,
  never trains on it, SOC 2 Type II.
- **Cost here: nothing** — open source is free. Pro is $12/seat/month, Team $24 (billed annually).
- <https://sourcery.ai/code-review>

*Prices and plans as of November 2026. Check the pages; they move.*

## Why this repo, specifically

- **It would stay advisory.** `main` has no branch protection today, so a bot's status shows up as a
  comment on the PR, not as a gate. Nothing merges differently the day it's installed. Making a check
  required later is a deliberate, separate decision.
- **Volume.** Several PRs an hour land here, each with tests and screenshots. Nobody reads all of them
  closely, and the one who does is the one who wrote them.
- **Where it pays.** `src/core/` holds SQLite, the MCP gateway, the per-turn tool URL, the approval
  check and the vault; `src/main/` holds the Electron window, the IPC handlers and the agents'
  browsers. A silent mistake in either is a permission or a data bug, not a typo.

## The real risk: noise

It will comment on every PR, including the ones you already know are fine, and a bot that talks too
much gets muted within a week — which is worse than not having one. Ways to keep it worth reading:

- Turn it on for **this repository only**, and start on a throwaway PR before pointing it at real work.
- Skip what a formatter or a linter already covers, and skip the parts of the tree where a nitpick is
  worthless (`site/`, `docs/`, lockfiles, `frames/`, the screenshot scripts).
- Don't ask it to review drafts.
- Keep the security pass on: that's the part CI can't do.

A starting point for CodeRabbit, to be committed in its own PR — Sourcery has its own config file,
same idea:

```yaml
language: en-US
reviews:
  profile: chill                     # fewer opinions, higher signal
  request_changes_workflow: false    # comment, never block the merge button
  high_level_summary: true
  poem: false
  path_filters:
    - "!site/**"
    - "!docs/**"
    - "!package-lock.json"
    - "!frames/**"
    - "!scripts/screens-*.mjs"
  path_instructions:
    - path: "src/core/**"
      instructions: >
        Core process: SQLite, the MCP gateway, the per-turn tool URL, approvals, the vault, runs.
        Flag anything that weakens a permission boundary, builds SQL or shell strings by hand, writes a
        secret to a log, or trusts a value that came from a model, a web page or a connector.
    - path: "src/main/**"
      instructions: >
        Electron main process. Flag IPC handlers that trust an argument from the renderer,
        shell.openExternal with a URL that wasn't validated, and paths joined with names that came
        from elsewhere.
```

## If it ever costs money

Today it doesn't: both are free for public repositories, so this proposal asks for nothing. If the
project goes private, or wants the paid security tiers, and the budget isn't there — this is a good
thing to crowdfund rather than quietly drop. Sponsors, or a handful of the people who run Tucano every
day, would cover either plan without much effort.

**If that's the case, contact me directly** — I opened this PR. I'd rather help find the money, or
cover it, than have the idea turn into a long issue thread about a subscription.

## What I'd do, in order

1. Install **one** of the two on this repository only, with nothing made required.
2. Open a throwaway PR with one deliberate mistake in `src/core/` — a check-then-use, or a SQL string
   built by hand — and see whether it's found. That's the whole test.
3. Found it? Keep it and commit the config above. Flooded with style? Tune the config before judging.
4. Not worth the noise? Uninstall. It leaves nothing in the repository but a config file you can
   delete.

No affiliation with either vendor, and nothing in it for me.
