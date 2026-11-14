# Workspaces
> Separating contexts (company and personal, for example): creating one choosing what to carry over, switching, duplicating, pausing, deleting, and what stays shared on the computer.

Each workspace has its own agents, conversations, connectors and credentials, memories, routines, skills and wiki. One does not see the other's content.

## Switching and seeing the others
Click the name at the top of the sidebar. The menu lists the workspaces with each one's unread and approvals (only those numbers, nothing of the content). Everyone's routines keep running while another one is on screen. A notification from another workspace, clicked, switches to it.

## Creating one
1. In the top menu, **+** (**Create Workspace**).
2. **Workspace name**.
3. **What to carry over from "…"?**, ticking whatever you want from the current workspace:
   - **General settings**: your name, language, router and memory models, limits, quiet hours and voice.
   - **Context**.
   - **Wiki**: the same wiki, not a copy. What one keeps, the other reads. Unticked, it starts with an empty wiki.
   - **Agents**: instructions, models, computers and lent folders, without the memories or the files.
   - **Channels**: names, topics and members, without the messages.
   - **Skills**: without the agents, the agent-specific ones come archived.
   - **Connectors and credentials** (GitHub included). Without them the agents come with no permissions.
   - **Routines**: only with the agents; the ones that are on run in the new one too, with new trigger addresses.
4. With nothing ticked it starts empty, with the introduction. With the agents, a workspace that is already set up skips the introduction.

Never carried over: messages, memories, summaries, approvals, usage history, the computers' files, browser sessions and the extra Claude Code and Codex accounts (the agents use the default login). Connectors with OAuth may ask for the login again.

## Managing them
The gear in the menu opens **Manage workspaces**: switch, pause or resume each one (or **Pause all**), duplicate (opens the same form with everything ticked) and delete.

## The name
In **Settings › General**, **Workspace name** is the name in the switcher; **What the agents call you** is your own name, separately.

## Deleting
In **Settings › General** › **Danger area** › **Delete workspace and all its data** (or the bin in the manager). It deletes agents, conversations, memories, credentials, routines and its local backups. Copy a backup out first. Project folders and other workspaces stay. If another workspace uses its wiki, the wiki folder is not deleted: it passes to the other.

## The default workspace
It is the data folder that already existed. It cannot be deleted. Telegram and **Open when the computer starts** live in it.

## What is shared
The Claude Code and OpenCode logins belong to the computer, not the workspace. A workspace separates data, but it is not a sandbox: an agent with **This computer** reaches the same disk.
