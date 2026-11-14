# Wiki
> What you and the team know, in linked pages: writing, importing from Obsidian, the curator that keeps it from the conversations, approving changes and the review.

The wiki is a set of Markdown pages, linked to each other (people, projects, subjects, decisions). An agent with access reads the wiki before answering and cites the pages.

## Using it
- Open **Wiki** in the sidebar. The screen shows the map of the pages and their links.
- **New page** (N) or **Search** (⌘K inside the wiki). Searching for a name that does not exist, **Write "…"** creates the page.
- Drag a file (PDF, Word, spreadsheet or text) onto the screen: the curator reads it and writes it into the pages.
- Each agent's access is on its page, the **Memory** tab: **Reads the wiki** or **No access**.

## The curator
A model that looks after the wiki. In **Wiki settings**:
- **Keep from conversations**: once a conversation settles, it keeps the decisions, the facts and the results in the pages. To turn it off in a channel or DM, in its menu in the sidebar, **Don't keep in the wiki**.
- **Changing a page that already exists**: **Asks for approval** or **Automatic** (on switching, what was already waiting goes in with it). In **Waiting for you**, **Approve all** approves the list at once. New pages always go straight in. Everything stays in the history, with **Undo**.
- **Review on its own every week**: looks for what does not add up, what went stale and what is repeated. What it finds waits for you under **Care**. You can **Review now** at any time.

**Curator decisions** shows what it wants to change in pages that already exist: **Approve**, **Refuse** or **Undo**. If the page changed after the suggestion, **Redo on the new version**.

## The folder
The wiki is plain Markdown in a folder: it opens in Obsidian, goes to iCloud or to git. In **Wiki settings** › **The folder**:
- **Open folder** shows where it is.
- **Change folder…** starts using another folder, which can be your Obsidian vault. The pages in the current folder stay there.
- **Back to Tucano's folder** returns to the folder inside the app.
- **Sync with git** makes the folder a clone of a repository (your Obsidian vault on GitHub, for example): what changes there appears here, and what is here goes there. See **wiki-git**.

**Import from Obsidian** (or **Import an Obsidian vault**) copies a vault with folders, links and attachments. The original vault is not touched.

**Wiki schema** is the page with the page types and how to write them; the agents and the curator follow it. It can be edited.

## With workspaces
Each workspace has its own wiki. When you create a workspace you can tick **Wiki** for it to use the same folder (not a copy): what one keeps, the other reads. See **workspaces**.

## When it goes wrong
- The agent does not cite the wiki: check that it has **Reads the wiki**.
- "The last review could not read the pages with the model": check that the memory model's harness is ready in **Settings › Models**.
