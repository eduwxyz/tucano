# Settings organization

Settings are grouped by the decision being made, with one canonical section for each setting. The existing setting keys, stored values, defaults, overrides and backend authorization remain unchanged. This proposal builds on the English wording improvements in #410.

## Page structure

| Page | Decisions |
| --- | --- |
| App | Personal appearance, conversation display, notifications, dictation, startup and updates |
| Workspace | Shared context, people, activity, import/export, backups and deletion |
| Agents | Reply behavior, recovery, permissions, resource limits and automation |
| Models | Agent model assignments, runtime setup, accounts and classifiers |
| Knowledge | Memory learning and Wiki capture, storage, imports and page rules |
| Connections | Phone/Telegram and server connections |

Related controls share understated rounded containers with thin borders and no heavy shadows. Section headings and spacing clarify their order, and the danger zone retains a red border. Input controls keep the application's existing affordances.

## Declared sections

The source of order and ownership is [settings-structure.ts](../src/renderer/src/settings-structure.ts). A section is shown only when the existing role and capability permit it. Personal preferences remain personal; workspace defaults and object-specific overrides keep their scopes.

| Page | Section | Stable ID | Settings keys |
| --- | --- | --- | --- |
| app | Appearance | app-appearance | theme, language |
| app | Conversation | app-conversation | stepsOpen |
| app | Notifications | app-notifications | sounds |
| app | Dictation | app-dictation | voice |
| app | Startup | app-startup | openAtLogin |
| app | Updates | app-updates | Existing RPC actions or information |
| workspace | Context | workspace-context | workspaceLabel, workspaceName, context, onboarding |
| workspace | People | workspace-people | Existing RPC actions or information |
| workspace | Activity | workspace-activity | Existing RPC actions or information |
| workspace | Import and export | workspace-transfer | Existing RPC actions or information |
| workspace | Backups | workspace-backups | Existing RPC actions or information |
| workspace | Data and deletion | workspace-danger | Existing RPC actions or information |
| agents | Replies | agents-replies | chainDepth |
| agents | Recovery | agents-recovery | runStallMinutes |
| agents | Permissions | agents-permissions | autonomy, actionRules, outsideGuard, approvalTtlHours |
| agents | Limits | agents-limits | defaultLimit, runBudgetPct |
| agents | Automation | agents-automation | quietHours |
| models | Agent models | models-agents | Existing RPC actions or information |
| models | Runtimes | models-runtimes | harnesses |
| models | Accounts | models-accounts | accounts |
| models | Classifiers | models-classifiers | routerModel, jevKey, browserJev |
| knowledge | Memory | knowledge-memory | memoryModel, memoryLearning |
| knowledge | Wiki capture | knowledge-wiki-capture | wikiCapture, wikiEdits, wikiReview |
| knowledge | Folder and Git | knowledge-wiki-storage | wikiDir |
| knowledge | Import notes | knowledge-wiki-import | Existing RPC actions or information |
| knowledge | Page rules | knowledge-wiki-rules | Existing RPC actions or information |
| connections | Phone and Telegram | connections-phone | telegram |
| connections | Servers | connections-servers | Existing RPC actions or information |

## Navigation

The main row uses tabs to switch page panels. The second row uses section links, because all sections on that page remain visible together. Links scroll the selected section clear of the sticky navigation and follow manual scrolling without moving focus. Pointer navigation uses an interruptible 280 ms ease-in-out transition; keyboard activation and reduced motion move immediately. Main tabs support arrow keys, Home and End. Both navigation rows scroll horizontally at narrow widths.

Stable IDs are independent of translated labels. Legacy General, Models, Agents, Phone, People, Activity and Servers destinations continue to resolve, including when a remembered destination becomes unavailable.

Wiki controls use the same implementation in Knowledge and the contextual Wiki settings dialog. Import and schema actions open their existing Wiki flows. Per-agent, channel and routine choices stay in their object editors.

## Adding a setting

Before coding, record the user's decision, whether a configurable choice is needed, setting key/path, canonical section ID, scope, permitted roles, default, dependencies, persistence, restart behavior, overrides and any privacy or destructive consequences in the feature's issue or PR. Review neighboring feature PRs for overlapping decisions.

Prefer an existing section serving the same task. A new section needs a distinct task and a place in the declared order. A new main page needs a revised architecture proposal explaining the moved controls, scope, roles, discoverability and narrow layouts. Do not add miscellaneous buckets or empty tabs for hypothetical features. Keep the registry and interaction tests current.

Labels name the action directly in sentence case. Hints add information rather than repeat the label and fit within two rendered lines at supported narrow widths. Keep disclosures and consequences complete; a destructive warning may need more space. Do not shrink text, truncate warnings or hide information to fit.

## Verification

Run `npm run check:settings` for declared ownership, rendering slots and navigation regressions. The source checker follows literal Settings updates through shared controls; dynamic patches, RPC actions and role authorization still need review and interaction checks. Run typecheck and the complete test suite before delivery.

After `npm run build`, run `node scripts/screens-settings-layout.mjs OUTPUT_DIRECTORY` against synthetic data. It checks section navigation, scroll tracking, focus, reduced motion, English hint wrapping and Portuguese navigation at 1280, 900 and 760 CSS pixels. The report includes screenshots and actual font, line and available-width measurements. Character counts are observations, not a universal fit budget.
