# Desktop workspaces (in progress)

A workspace keeps its own agents, conversations, memory, connector credentials,
engine working directories, browser profiles and routines. Click the logo/name
at the top of the sidebar to switch or use the **+** beside the gear to create a workspace. Creation uses
the same setup as a fresh installation; it does not copy another workspace's data.

Use the gear icon in the workspace menu to open **Manage workspaces**. It lists
every workspace with create, duplicate and delete actions.

Each row also has a pause/resume control. It uses the same per-workspace pause
as the sidebar: no new agent work or routines start, but running work can finish.
The button at the top pauses all workspaces, or resumes them when all available
workspaces are paused. Unavailable cores are reported rather than started as a
side effect of pausing. Pause state is saved in each workspace's own database.

Creating and duplicating are one form: a name, and what to bring from a workspace,
each part ticked on its own: the general settings (the person's name, language,
router and memory models, limits, quiet hours, voice), the context, the wiki,
agents,
channels, skills, connectors with their encrypted credentials (and GitHub's), and
routines. Creating starts from the workspace on screen with only the general
settings ticked; with nothing ticked it starts empty, with the introduction.
Duplicating a row of the manager ticks everything and suggests the source name
with the next available count, such as `Company (2)`. The app opens the new
workspace once it's made.
What depends on something left behind comes without it: agents without the
connectors have no grants, a skill of specific agents comes archived without
them, a routine comes only with its agent and place (and a connector it polls).
The wiki isn't copied: the new workspace uses the same folder, so what one keeps
the other reads; without it, it gets its own, empty. Deleting a workspace whose
own wiki another one uses keeps that folder, moved to the first one using it.
With its agents, a set-up workspace skips the introduction; without, the
introduction starts from what came. Never copied: messages, memories,
conversation summaries, approvals, usage history, artifacts, running services,
computer files, browser sessions, nor the extra Claude Code/Codex accounts (their
sign-ins live in the source's folder and the keychain): agents use the usual sign-in.
Lent folders and linked skills remain references to the same external files.
Changes to those external files are not isolated by making a copy.

Enabled routines remain enabled and run independently in the copy, with fresh
schedules and webhook tokens. Telegram credentials and temporary authentication
state are not copied; Telegram remains default-only. Some OAuth connectors may
need reauthorization. Duplicating never changes the original workspace.

The original data folder is the default workspace and stays where it was. New
workspace folders use UUIDv7 identities under `workspaces/`, with a main-owned
`workspaces.json` registry. Every registered workspace starts its own core when
the app opens, migrates its database before work starts, and keeps its routines
running even when another workspace is on screen. Explicit pause and quiet hours
still apply. Closing the app entirely stops all cores.

Theme is app-wide, not per workspace. Changing it in any workspace updates all
running workspaces, and new or duplicated workspaces inherit it. The choice
survives restarts; on the first upgrade, the default workspace's existing theme
becomes the shared preference. Server mode keeps its single-workspace settings.

The selector shares only names, unread counts and pending approval counts.
Conversations, memory and credentials are not combined. Default webhook/git
ports remain 47717/47718; other workspaces have persistent separate assignments.
A port already taken (another Tucano open, say) is logged and that workspace keeps
running without it: a call there reaches a server that doesn't know its tokens.

At the end of **Settings > General**, the **Danger area** contains backup controls
and workspace deletion. Deletion requires an OS confirmation dialog and removes
that workspace's data, including its local backups and the transcripts Claude Code
keeps for its agents in `~/.claude/projects`. Copy a backup outside the
workspace before confirming. External project folders and other workspaces are
kept. The default workspace is protected: it cannot be deleted from Settings,
the manager or the backend. Its backup and duplication actions remain available.

## Limits of this implementation slice

- Workspace separation is not an OS sandbox or protection against hostile agents.
  Folder restrictions, reviewed repository import and channel project resources
  are planned separately and are not implemented yet.
- Claude Code/OpenCode sign-ins remain machine-wide. Workspace separation does
  not create different provider accounts or constrain network/MCP/desktop tools.
- Telegram and the app's login-at-startup preference belong to the default
  workspace. Every workspace starts together at application startup.
  In other workspaces, the Telegram settings notice shows the default workspace's
  name as a link that switches there. The link is hidden in the default workspace.
- Server mode is unchanged: one workspace per `TUCANO_DATA`, with no desktop
  workspace selector or registry management.
- Failed cores can be retried from the selector. Automatic crash backoff and
  comprehensive multi-platform/native lifecycle verification are still pending.
