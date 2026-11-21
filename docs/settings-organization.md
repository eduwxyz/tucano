# Settings, organized by task

The Settings page kept the order its controls were built in. What a person changes about themselves
(language, theme, notifications), about the workspace (its name, the shared context, the team) and
about this computer (launching at login, updating) stood in the same column, and a new control could
find several plausible homes.

This changes where the controls stand and how the page is walked. It adds no setting, changes no
value, default, permission or scope, and keeps every tab's id and name, so a link to `Configurações ›
Modelos` still lands there.

## One declaration per setting

`src/renderer/src/settings-structure.ts` declares every section once: its id, the tab it belongs to,
the settings keys it owns, its scope and who can see it. The page renders each card inside the
section it declares (`<Card section="app-notifications">`, or `SectionAnchor` around a card that
lives in another file), and the strip under the tabs is built from the same declaration.

| Tab | Sections |
| --- | --- |
| General | Appearance · Workspace context · Dictation · Notifications · Conversations · Talk to the people who make Tucano · Updates · Team · Backups · Data and deletion |
| Models | Agent models · Harnesses · Accounts · Router · Memory |
| Agents | Permissions · Tuca · Agents browser · Routines · Limits |
| Phone | Phone and Telegram |
| People | People |
| Activity | Activity |
| Servers | Servers |
| Harnesses | Harnesses (MCP) |

Order inside a tab is the reading order of its cards: what most people change first, destructive
actions last. A section that a role or a capability leaves out is not rendered, and the strip does not
link to it, so there are no dead anchors.

## Walking the page

Under the page's own tabs, a second row names the sections of the open tab. It stays under the tabs
while the page scrolls, follows the reading position, and takes the pane to a section. It is links,
not a second tab list: the sections stay visible together and all belong to one scrolling document, so
the active link carries `aria-current="location"`.

A pointer selection scrolls with an interruptible 280 ms ease-in-out. A keyboard activation and a
reduced-motion preference move at once. Wheel, touch, pointer or key input, a new selection, or
unmounting cancels a running animation. The section the pane lands on takes focus without a second
scroll. The row wraps instead of scrolling sideways at narrow widths, so at 900 px the last sections
stay reachable.

## Adding a control

1. Declare the section, or extend the existing one, in `settings-structure.ts`, with the settings keys
   it writes.
2. List that section in `tabSections` for the tab whose cards show it.
3. Render the card in `Pages.tsx` with `section="<id>"`, or wrap it in `SectionAnchor`.

`npm run check:settings` checks the three against each other and fails when a declared section has no
card, a card belongs to no section, two sections own the same key, or a key is not in `Settings`. The
placement judgement itself — which section a control belongs to, and its scope — stays the review in
the pull request.

Settings that live on their own surface stay there: a channel's Wiki controls stay on the Wiki page, a
person's name stays in People, and the per-agent overrides stay on the agent's page.

## Evidence

- `npm run check:settings` — the placement check plus `test/settings-structure.test.ts` and
  `test/settings-navigation.test.tsx`.
- `npm run build && node scripts/qa-settings-sections.mjs` — the built app, at 1280, 1024, 900 and
  760 CSS pixels, on every tab: the strip does not scroll, every link has its card, and a click parks
  that card 16 px under the strip with the section focused.
