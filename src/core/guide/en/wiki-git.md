# Wiki in git
> The wiki folder kept in a git repository (the Obsidian vault on GitHub, for example): connecting with a deploy key, what syncs, conflicts, read only, and Obsidian Git on the Mac.

For a Tucano on a server to use the same Obsidian vault you use on the Mac. The repository is the truth. Only the owner and the admins set it up.

## Connecting
In **Wiki** › **Wiki settings** › **The folder** › **Sync with git** › **Set up…**:
1. Paste the repository's SSH address (on GitHub: **Code** › **SSH**, like `git@github.com:you/vault.git`). An https address works too: Tucano shows its SSH one.
2. Tucano generates a key for this wiki only. **Copy**, and **Add on GitHub** opens the repository's deploy keys page (GitLab, Bitbucket and Gitea too). Paste the key into **Key** and give it a name, like Tucano.
3. Tick **Allow write access** to read and write. Unticked, the wiki stays read only. On Bitbucket the access key only reads.
4. **Test the connection**: Tucano clones the repository and says how many pages, PDFs and docx it has.
5. If the wiki already has pages, choose: **Use the repository** (the wiki shows only what is there) or **Merge with the ones here** (the pages here go into the repository; one with the same name goes in as "(Tucano version)"). Either way the old folder stays as it was, as a backup.

## What syncs
- On opening, every 2 minutes and before the curator writes, Tucano brings in what changed in the repository.
- A page saved (by you, by someone on the team, by the curator) goes to the repository a few seconds later, with the message "Tucano: <page> (<who>)".
- **Sync now** does it on the spot. The status shows the last time and, if it failed, why and when it tries again.
- Never into the repository: pages kept for one person (the **Release to the team** ones), sources that came from a DM, Tucano's index and record, and files above 50 MB (a warning appears under **Care**).

## Conflicts
If the same page changed in the repository and in Tucano, the repository's stays. Tucano's becomes "<page> (Tucano version)", goes to the repository too, and a warning appears under **Care**.

## Read only
If the key cannot write, Tucano notices on the first push: the wiki gets the **Read only** badge, shows what is in the repository and accepts no writing (not yours, not the curator's). What did not get out stays in the folder. To write: tick **Allow write access** on the key and tap **Try writing again**.

## Obsidian Git on the Mac
In Obsidian: **Settings** › **Community plugins** › search **Git** (by Vinzent) › install and enable. In its options, turn on **Auto pull interval** and **Auto commit-and-sync interval** at 2 to 5 minutes, and **Pull on startup**. The vault must be a clone of the same repository.

## When it goes wrong
- "it refused the key": the key was deleted or revoked in the repository. Add it again, or **Disconnect** and connect again to generate another.
- "it did not find that repository": check the address; without the key, GitHub says it does not exist.
- "Git is not installed": on the Mac, `xcode-select --install`; on Windows, Git for Windows; on Linux, `sudo apt install git`.
- **Disconnect** stops the syncing and deletes the key; the folder keeps the pages. Delete the deploy key in the repository too.
