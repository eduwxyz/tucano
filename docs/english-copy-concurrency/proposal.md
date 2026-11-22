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

Rendered evidence is pending for the server banner, agent override and reply
concurrency controls at 900 and 1280 CSS pixels. Up to six paired before/after
images cover all nine replacements using real components and synthetic data.
The review must confirm that labels fit, ordinary hints stay within two lines,
and all consequences remain visible without clipping or smaller type.
