# English copy validation

Base: upstream main `73b724bec8a576d316a5dd5f46a07e3bf83cbe75`. The implementation
is carried by this PR's current head. The proposal was committed before the
application strings changed. This pass replaces 267 English occurrences in 15 source files.
An AST comparison confirms that Portuguese arguments and executable behavior are unchanged.

## What fits in two lines

The built server renderer was measured in headless Edge at 1280 × 900 and 900 × 900 CSS pixels,
using the shipped Inter Variable font. The desktop minimum width is 900 px. DOM Range rectangles
count rendered lines; each report also records the hint's width, font size, line height, and character
count. No font reduction, line clamp, or truncation was added.

These measured capacities use the same sample text, extended until it produces a third line. They
are useful drafting budgets, rather than limits that every combination of letters and words shares.

| Text area | Available width | Font size | Line height | Sample characters in two lines |
| --- | --- | --- | --- | --- |
| Full Settings hint, 1280 px window | 678 px | 13 px | 20.15 px | 203 |
| Full Settings hint, 900 px window | 538 px | 13 px | 20.15 px | 162 |
| Half-width Settings field, 1280 px window | 333 px | 12 px | 18.6 px | 116 |
| Half-width Settings field, 900 px window | 263 px | 12 px | 18.6 px | 88 |
| Original Wiki edit row | 327.2 px | 12.5 px | 18.125 px | 116 |

The wider **Ask for approval** button leaves about 289 px for the revised Wiki edit hint. Its 84
characters still fit two lines. This is why measuring the whole 560 px dialog would overstate the
space available to the words.

| Example | Original characters | Original lines | Revised characters | Revised lines |
| --- | --- | --- | --- | --- |
| Wiki edit policy | 126 | 3 | 84 | 2 |
| Consecutive agent replies, at 900 px | 122 | 3 | 48 | 1 |
| Dictation, at 900 px | 256 | 3 | 135 | 2 |

At 900 px, ten of the original measured hints exceeded two lines. The replacement set leaves one:
the full-backup replacement warning. That text retains the affected data, replacement consequence,
and database-only backup alternative. All measured ordinary hints in General, Models, Agents,
Phone, and Wiki settings fit two lines. Conditional controls absent from upstream main are not
covered by these upstream screenshots.

## Screenshots

The captures use scratch data and fake engines. They show the built application renderer, including
its real controls and fonts. The screenshot commit is immutable.

| Surface at 900 px | Before | After |
| --- | --- | --- |
| Wiki settings | [Before](https://raw.githubusercontent.com/apoapostolov/tucano/05c5a7f3c2536549e376508a7730b8495eabaf01/docs/screenshots/english-copy/before/900-wiki-settings.png) | [After](https://raw.githubusercontent.com/apoapostolov/tucano/05c5a7f3c2536549e376508a7730b8495eabaf01/docs/screenshots/english-copy/after/900-wiki-settings.png) |
| Limits | [Before](https://raw.githubusercontent.com/apoapostolov/tucano/05c5a7f3c2536549e376508a7730b8495eabaf01/docs/screenshots/english-copy/before/900-agents-03-Limits.png) | [After](https://raw.githubusercontent.com/apoapostolov/tucano/05c5a7f3c2536549e376508a7730b8495eabaf01/docs/screenshots/english-copy/after/900-agents-03-Limits.png) |
| Accounts | [Before](https://raw.githubusercontent.com/apoapostolov/tucano/05c5a7f3c2536549e376508a7730b8495eabaf01/docs/screenshots/english-copy/before/900-models-02-Accounts.png) | [After](https://raw.githubusercontent.com/apoapostolov/tucano/05c5a7f3c2536549e376508a7730b8495eabaf01/docs/screenshots/english-copy/after/900-models-02-Accounts.png) |

## Checks and limits

Typecheck, production build, and the built-renderer check pass. The latter produced 36 screenshots
and 88 hint measurements with no renderer errors. The pushed commit was checked again from a fresh
worktree: typecheck passed, with 18 focused tests passed and three skipped.

The [upstream CI run](https://github.com/eduwxyz/tucano/actions/runs/43431057506) passed all six jobs:
Linux, macOS, and four Windows test shards. Local Windows runs exposed timing failures outside the
copy changes. The first run passed 1,693 tests, skipped 64, and failed three execution/timing cases.
A later run passed 1,695, skipped 64, and failed the Claude sign-in fixture's transient URL assertion.
Clean upstream reproduced Wiki Git timeouts; its isolated engine-setup file passed all 14 tests.
These local failures are retained here rather than described as a fully green local suite.

Run the layout check after building:

```sh
node scripts/check-english-copy.mjs /path/to/report
```

By default it uses Playwright Chromium. `TUCANO_BROWSER_CHANNEL=msedge` or `chrome` selects an
installed browser. `--baseline` records the same evidence without enforcing the two-line target.
Character capacity is specific to the measured font, width, and sample; other font sizes or zoom
levels require another measurement. The script checks layout and renderer errors, not comprehension
with participants.
