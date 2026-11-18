# Settings organization

Settings are grouped by the decision being made, with one canonical section for each setting. The setting keys, stored values, defaults, overrides and backend authorization are unchanged: this is a placement and navigation change on top of the settings tabs that already exist.

## Page structure

The settings page keeps its tabs. Each tab is a pane; the sections of that pane are listed in one rail under the tab bar, as that pane's second row of tabs: the same width as the tabs, the same underline for the section in view, and no separate pill for it.

| Pane (tab id) | Decisions |
| --- | --- |
| General (`geral`) | Appearance, shared context, dictation, notifications, conversations, feedback, updates, team, backups and deletion |
| Models (`modelos`) | Agent model assignments, runtimes, accounts, the router and memory |
| Agents (`agentes`) | Autonomy, the agents' browser, routines and limits |
| Phone (`integracoes`) | Phone and Telegram |
| People (`pessoas`) | Who has access and what each one can do |
| Activity (`atividade`) | Workspace activity |
| Servers (`servidores`) | Servers and the node, when the computer has them |

Related controls share understated rounded containers with thin borders and no heavy shadows. Section headings and spacing clarify their order, and the danger zone retains a red border. Input controls keep the application's existing affordances. Two short fields that belong together share one row, each keeping its own label.

## Declared sections

The source of order and ownership is [settings-structure.ts](../src/renderer/src/settings-structure.ts). A section is shown only when the existing role and capability permit it, and a section belongs to exactly one pane. Personal preferences remain personal; workspace defaults and object-specific overrides keep their scopes.

| Pane | Section | Stable ID | Settings keys |
| --- | --- | --- | --- |
| geral | Appearance | geral-appearance | theme, language |
| geral | Workspace context | geral-workspace | workspaceLabel, workspaceName, context, onboarding |
| geral | Dictation | geral-voice | voice |
| geral | Notifications | geral-notifications | sounds |
| geral | Conversations | geral-conversation | stepsOpen |
| geral | Feedback | geral-feedback | surveys |
| geral | Updates | geral-updates | seenVersion |
| geral | Team | geral-team | Existing RPC actions or information |
| geral | Backups | geral-backups | Existing RPC actions or information |
| geral | Data and deletion | geral-danger | Existing RPC actions or information |
| modelos | Agent models | modelos-agents | Existing RPC actions or information |
| modelos | Runtimes | modelos-runtimes | harnesses |
| modelos | Accounts | modelos-accounts | Existing RPC actions or information |
| modelos | Router | modelos-router | routerModel, jevKey |
| modelos | Memory | modelos-memory | memoryModel, memoryLearning |
| agentes | Autonomy | agentes-autonomy | autonomy, actionRules, outsideGuard |
| agentes | Agents' browser | agentes-browser | browserJev |
| agentes | Routines | agentes-routines | openAtLogin, quietHours |
| agentes | Limits | agentes-limits | defaultLimit, runBudgetPct, runStallMinutes, chainDepth, approvalTtlHours |
| integracoes | Phone and Telegram | integracoes-phone | telegram |
| pessoas | People | pessoas-people | Existing RPC actions or information |
| atividade | Activity | atividade-activity | Existing RPC actions or information |
| servidores | Servers | servidores-cards | paused |

## Navigation

The page's tabs still switch panes, and arrows, Home and End stay with the tab strip. Inside a pane, the rail lists that pane's sections only, because those sections stay visible together as one document. It sticks under the tab strip rather than over it, so the tabs stay reachable. Links scroll the chosen section clear of the sticky rail and follow manual scrolling without moving focus or writing navigation state. Pointer navigation uses an interruptible 280 ms ease-in-out transition; keyboard activation and reduced motion move immediately. The rail scrolls horizontally at narrow widths.

The section a pane last landed on is kept per pane, so returning to a tab resumes where the person was. Stable IDs are independent of translated labels. Destinations named before the sections existed (`geral`, `modelos`, `agentes`, `roteamento`, `integracoes`, `pessoas`, `atividade`, `servidores`, and the older page names) still resolve to a section; a destination that belongs to another pane, or to a section this person cannot see, leaves the current pane on its first section.

Per-agent, channel and routine choices stay in their object editors. Wiki settings stay in the Wiki page and its settings dialog; they are not repeated under Models.

## Adding a setting

Before coding, record the user's decision, whether a configurable choice is needed, setting key/path, canonical section ID, scope, permitted roles, default, dependencies, persistence, restart behavior, overrides and any privacy or destructive consequences in the feature's issue or PR. Review neighboring feature PRs for overlapping decisions.

Prefer an existing section serving the same task. A new section needs a distinct task, a pane to live in, and a place in the declared order. A new tab needs a revised architecture proposal explaining the moved controls, scope, roles, discoverability and narrow layouts. Do not add miscellaneous buckets or empty tabs for hypothetical features. Keep the registry and interaction tests current.

Labels name the action directly in sentence case. Hints add information rather than repeat the label and fit within two rendered lines at supported narrow widths. Keep disclosures and consequences complete; a destructive warning may need more space. Do not shrink text, truncate warnings or hide information to fit.

## Verification

Run `npm run check:settings` for declared ownership, rendering slots and navigation regressions. The source checker follows literal Settings updates through shared controls; dynamic patches, RPC actions and role authorization still need review and interaction checks. Run typecheck and the complete test suite before delivery.

After `npm run build`, run `node scripts/screens-settings-layout.mjs OUTPUT_DIRECTORY` against synthetic data. It checks section navigation, scroll tracking, focus, reduced motion, English hint wrapping and Portuguese navigation at 1280, 900 and 760 CSS pixels. The report includes screenshots and actual font, line and available-width measurements. Character counts are observations, not a universal fit budget.
