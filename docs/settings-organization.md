# Settings, organized by task

The Settings page kept the order its controls were built in, across eight tabs. What a person changes
about themselves (language, theme, notifications), about the agents, about the models, about what
connects to Tucano and about the workspace stood side by side, and a new control could find several
plausible homes.

This changes where the controls stand and how the page is walked. It adds no setting and changes no
value, default, permission or scope.

## Five groups, one subject at a time

`src/renderer/src/settings-structure.ts` declares every subject once: its id, the group it belongs
to, its name, its tile (an icon from `ui.tsx` on one of the app's colours), the settings keys it owns,
its scope and who can see it.

| Group | Subjects |
| --- | --- |
| You | General · Appearance · Notifications · Dictation · Conversations |
| Agents | Autonomy · Limits · Routines · Tuca · Browser |
| Models | Agent models · Harnesses · Accounts · Router · Memory |
| Connections | Phone and Telegram · Servers · MCP access |
| Workspace | People · Activity · Move the team · Backups · Updates · Data and deletion |

Order inside a group is reading order: what most people change first, what can't be undone last. A
group shows only when this person has a subject in it, so a member never sees an empty Agents group.

The page renders each subject with `SectionAnchor`, which draws the subject's tile and name over its
cards. A `Card` inside a subject is one of its groups of rows: a small heading (left out when it only
repeats the subject's name), its lead, and the rows in one rounded box.

## Walking the page

The five groups sit at the top as one segmented control, and stay there while the page scrolls. Under
them, a row of links names the subjects of the open group and takes the page to one. A pointer click
glides over an interruptible 280 ms ease-in-out; a keyboard activation and a reduced-motion preference
move at once; wheel, touch, pointer or key input, or another link, stops a glide. The subject lands
16 px under the groups and takes the focus without a second scroll. A subject the page did not draw
gets no link.

The search at the top right finds a subject by its name or by any of its terms (`settingsTerms`: the
controls in it, as a person would call them), ignoring accents and case, among the subjects this
person sees. Picking a result opens its group at that subject. Esc clears the search.

The old tab ids still work: a link written for `servidores`, `pessoas`, `atividade`, `integracoes` or
`harnesses` opens the group of that subject, at it (`settingsTabAliases`).

## Adding a control

1. Declare the subject, or extend the existing one, in `settings-structure.ts`, with the settings
   keys it writes, and add the words a person would search it by to `settingsTerms`.
2. List that subject in `tabSections` for its group.
3. Render it in `Pages.tsx` inside `<SectionAnchor id="<id>">`, with its cards.

`npm run check:settings` checks the three against each other and fails when a declared subject is not
rendered, something rendered belongs to no subject, two subjects own the same key, or a key is not in
`Settings`. The placement judgement itself — which subject a control belongs to, and its scope — stays
the review in the pull request.

Settings that live on their own surface stay there: a channel's Wiki controls stay on the Wiki page, a
person's name stays in People, and the per-agent overrides stay on the agent's page.

## Evidence

- `npm run check:settings` — the placement check plus `test/settings-structure.test.ts` and
  `test/settings-navigation.test.tsx`.
- `npm run build && node scripts/qa-settings-sections.mjs` — the built app, at 1280, 1024, 900 and
  760 CSS pixels, on every group: nothing scrolls sideways, every link has its subject, and a jump parks
  that subject 16 px under the groups with the subject focused.
