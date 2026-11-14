# Computer, folders, GitHub and browser
> Where an agent runs commands (an isolated Linux or this computer), lent folders, services left running and the agent's browser.

## The agent's computer
On the agent's page, the **Tools** tab › **Computer**:
- **None**: conversation, web and browser only.
- **Isolated Linux**: a computer of its own, apart from yours, in a Docker container. It installs and runs what it needs without asking. Its working folder is `/work`. It needs Docker running (Docker Desktop on Mac and Windows). It starts by itself when needed; there is **Start now**, **Restart** and **Erase computer** (erases everything, `/work` included).
- **This computer**: commands run straight on your computer, as you. You have to confirm it in **Let it use this computer**. Commands start in its folder (**Open its folder**). No Docker and no lent folders needed: it reaches your folders directly. In the sidebar the agent gets the "on your computer" mark.

With a computer, the agent creates files, runs commands and brings up sites and apps for you to see.

## Services
A site or app the agent brings up shows its **port** and its state (**running** or **stopped**): **Open** shows it beside you, **Stop** takes it down. **Stop services** stops all of them. If a service stopped, ask the agent to bring it up again.

## Folders on your computer
In **Folders on your computer**, **Lend a folder…** gives the agent a project's folder. For each one: **Read only** or **Can change**, and **Give back**. It edits the real files, so use git so you can undo. Lending or giving back restarts the agent's computer: services stop, what it installed stays.

## GitHub
To publish on GitHub (create a branch, send files, open a PR) the agent uses the **GitHub connector** (in **Connectors**) with **Read and write**, with the permissions and approvals of any connector. On **Isolated Linux** there are no credentials: `git push` does not work there. On **This computer**, `git push` runs with the git credentials you already have. If an agent says "the session is read-only", check that it has **Read and write** on GitHub and that **Push commits** and **Open pull request** are not set to **Never**.

## The agent's browser
On the **Tools** tab, **Browser**: a Chrome of its own, with logins kept apart from yours. It opens pages, clicks, fills in and reads like a person. A click that buys, publishes, sends or deletes asks for your approval.
- You follow it in the **…'s browser** panel. To sign in to an account, or solve a code or captcha: **Take over**, do what you need and **Hand back**.
- **Open its browser** opens the window for you to sign in to accounts beforehand.
- **Delete logins** takes out its logins, cookies and history.
- In **Settings › Agents** › **Agents' browser**: finding what to click **From the page's text alone** (free) or with Jev, from TypeSafe (which sends the list of elements, sometimes the screenshot, to TypeSafe).

## When it goes wrong
- **no Docker** / "Needs Docker running": open Docker Desktop and click **Check again**.
- **it did not start**: try starting it again; if it stays down, **Erase computer** and start from zero.
