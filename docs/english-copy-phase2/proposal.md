# English copy review, phase 2

This proposal revises 195 English interface strings after accepted #410. The
initial audit used `98554fdd007637409696f98e061973b5ca9338c6`; the PR now includes
upstream `2e38864165b3cf8b0ee522b890e07db239d25a7b`. It makes actions,
settings and consequences easier to understand across Settings, conversations,
agent setup, the task board, Vault, server access, invitations and feedback.
The initial review considered 206 candidates and deferred 24. A further review
of 50 incoming English occurrences revised 13, retained 35 and excluded two
model-facing or test-engine strings.

The edits preserve behavior. They change English literals without changing
Portuguese strings, localization structure, interpolation expressions, model
identifiers, settings keys or defaults. Labels name the action or setting;
hints retain the scope, conditions and consequences needed to make a decision.
[replacements.json](replacements.json) records every applied replacement with its
review ID, source file, line, context, original source string, before/after
English and editorial reason. Line numbers describe the reviewed candidate.

## Editorial decisions

Use consistent product terms such as agent, runtime, model and fallback model.
Replace ambiguous pronouns, incomplete phrases and first-person error narration
with the affected action or object. Keep recovery instructions concrete and
avoid promising recovery that the implementation cannot provide.

Shorter wording must preserve permission boundaries and privacy disclosures.
Server access still distinguishes restricted file tools from the terminal's
broader access and names the approval conditions. Vault text retains encryption,
visibility restrictions, personal ownership, requester attribution and the
consequence of replacing an agent's login. Feedback text still lists the version,
system, language and optional screenshot sent with the message. Destructive
warnings retain the affected resources, retained data and any irreversible result.

Behavior determines the wording where a shorter proposal could mislead. Starting
a new Tuca conversation replaces the current conversation; leaving the page keeps
it. The Vault validation example uses a complete HTTPS address accepted by the
parser. Permission descriptions account for existing approval rules rather than
claiming that every command always requires another approval.

## Scope kept separate

Internationalization work belongs in #618. This proposal preserves the existing
language branches and does not translate unconditional Portuguese placeholders.
Skills copy belongs in #608 and is deferred here. Model prompts, tool descriptions
and tool outputs are also deferred because changes to those strings require a
separate behavior review.

## Rendered review and evidence

The rendered review covers real interface components at 900 and 1280 CSS pixels
with synthetic data, including expanded controls, long values and relevant
permission states. Check labels and buttons for unexpected wrapping and hints
for more than two lines. Destructive and privacy warnings may need more space;
record the reason and verify that the full warning remains visible. Text must
not be clipped, hidden or reduced in size to pass a measurement.

The [evidence package](https://github.com/apoapostolov/tucano/tree/c548ff8ae7c5c999abf4d174e20d95868721bcb5/docs/english-copy-phase2/evidence)
contains 16 annotated before/after frames: 12 Settings groups, forgotten memory,
Vault login validation, feedback with an attachment, and a one-time routine.
They show actual built components with synthetic data. The attachment fixture is
synthetic and no feedback was submitted. Original component screenshots appear
in full at their original size; annotations sit outside the application image.

Frames 02 and 05 compare upstream `2e388641` with candidate `a6f698ed`.
The remaining 14 compare the initial baseline `98554fdd` with `3d2f538e`;
their affected components retain those revisions. Each frame names its capture
SHAs, and the manifest records full source SHAs and image hashes. Headless Edge used
900- and 1280-pixel viewports, 900 pixels high, with device scale 1. JSON records
the actual font, available width, character count, line count and overflow.
There are 116 Settings/Wiki measurements and 12 additional-state measurements
per version, plus ten new reasoning/reply-mode measurements per version.
The proposed text has no overflow or failed measurements. Changed ordinary hints in the captured states fit
within two lines. The complete Tuca application/Undo explanation and destructive
backup-restore disclosure take three lines; the layout review records why their
full consequences must remain visible. Three other long measurements are
unchanged text, outside this replacement set.

| Hint at 900 pixels | Text width | Font / line height | Before | After | Estimated two-line sample budget |
| --- | --- | --- | --- | --- | --- |
| Reply limit | 267 px | Inter Variable 12 / 18.6 px | 232 characters, 6 lines | 82 characters, 2 lines | 93 characters |
| Dictation introduction | 572 px | Inter Variable 13 / 19.5 px | 321 characters, 4 lines | 166 characters, 2 lines | 188 characters |

Those sample budgets depend on the letters and words. Actual rendered line
counts establish fit. This evidence covers the captured states; it does not
certify every conditional tooltip, user-facing error or permission state.

## Validation status

`npm run typecheck`, `npm run build`, `git diff --check` and the affected test
selections pass (9 files / 86 tests and 4 files / 42 tests) on the verified
pushed head `a6f698ed`. Parsed-source comparison confirms that all
195 source changes are English arguments of `L(...)` across 34 files;
Portuguese and the surrounding application syntax are unchanged. One Settings
navigation test expectation now matches the revised empty-result text.

The initial candidate, before merging the newer upstream commits, reported
239 files and 2,381 tests passing, with two failures:
the routine calendar fixture fails identically on the unchanged baseline, and
the Tuca batch test intermittently reaches its 20-second polling deadline while
the reply is still working. The unchanged candidate also passed all 11 Tuca
tests. A diagnostic copy with only that polling deadline extended passed all 11;
the slow case took 23.3 seconds. No production behavior or test deadline was
changed to conceal these failures. Upstream #619 subsequently corrected the
calendar fixture and is included here. A full-suite rerun on the current pushed
head is in progress; the earlier result does not describe a fresh full run.
