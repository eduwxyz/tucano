# Reply concurrency and server settings copy

This follow-up to merged #622 revises nine English interface strings introduced
by #626 and #621. The baseline is `e44b688213f1ec70868d685d5a336b3772f1810d`.
The changes clarify reply concurrency, an agent’s “One reply at a time” override,
and the distinction between server settings and settings on a specific computer.

“Concurrent replies per conversation” names the setting consistently in its
label, accessibility name and search terms. Its hint explains that prompts start
separate replies until the limit is reached, then queue until a reply finishes.
The agent hint preserves the override’s scope across all conversations and the
global setting that applies when it is off. The maximum remains six.

The server banner identifies where settings apply and where to manage settings
for a specific computer, including lending it to agents: “Settings for server
{host}. Manage local settings and agent lending in each computer’s Tucano app.”
The button names the
settings it opens. These edits preserve the existing behavior, permissions,
defaults, Portuguese strings, localization structure and interpolation.
[replacements.json](replacements.json) records all nine exact replacements and
their editorial reasons, with source keys and candidate line numbers.

## Validation and rendered evidence

Parsed-source comparison against the baseline confirms that only nine English
arguments of `L(...)` changed across two files. Portuguese and surrounding
application syntax are unchanged. `npm run typecheck` passes. The targeted
concurrency/server selection passes all 45 tests across five files. This
follow-up does not claim a full-suite run.

Eight paired frames show the reply concurrency controls, agent override and
server banner at 900 and 1280 CSS pixels. Two frames show the conditional
computer-settings button using a synthetic desktop bridge function; the actual
component renders the button and the function is not invoked. The workspace,
agents and server addresses are synthetic. The captures use baseline
`67c0494d025a70553e5474a6e99e013b65e13bf0` and candidate
`7c4f2e040a87d3923062af2c97767c5036c67e00`; the nine original strings also
match the accepted baseline. A manifest records the individual image hashes.

Headless Edge measurements at device scale 1 pass all ten candidate states:
labels and choices fit on one line, and ordinary hints and the server banner
fit within two lines without overflow. With the conditional button at 900 pixels,
the server banner falls from four lines to two in 350 pixels of available text
width. The browser captures do not substitute for the separately recorded
installed Electron measurements.
