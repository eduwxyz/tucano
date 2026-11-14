# Team, import and backups
> Exporting and importing the team as a .md file, bringing agents over from OpenBot, Grok Bot or Hermes, and the database backups.

It lives in **Settings › General**.

## The team in a file
In the **Team** card:
- **Export team**: downloads a .md with the agents, the skills, the channels and the routines, without credentials or conversations. Keep it, or take it to another computer. The Tuca does not come along: each installation has its own.
- **Import team…**: reads an exported .md. Only what does not exist here yet comes in; the routines arrive turned off. At the end a summary says what came in and what stayed out.

## From another app
**Import from another app…** takes a .zip:
- **OpenBot**: in the server's settings → Transfer → Export from this server, with the files.
- **Grok Bot**: it does not export on its own. **Skill for Grok Bot (experimental)** downloads a skill: give it to one of your agents over there (or paste the text into a conversation) and ask "Export my agents to Tucano". It answers with a .zip. It is experimental: read the import summary.

## From Hermes
**Import from Hermes…** reads the Hermes Agent folder on this computer (`HERMES_HOME` or `~/.hermes`, or another one you pick) and shows what comes in before importing. Each profile becomes an agent; with several, you choose.
- **Comes in:** the `SOUL.md` as instructions, its memories and yours (`USER.md`), the skills you created or installed, the ones that came with Hermes and you edited, and the scheduled tasks that fit a routine here.
- **Name only, in the summary:** MCP servers, Telegram/Discord/Slack, schedules with no equivalent (every 30 minutes, several times a day) and the model.
- **Never:** `.env`, `auth.json`, conversations, history, logs and the skills that came with Hermes unchanged. A link inside the Hermes folder is not followed.

Imported agents arrive with no connector at all, web search off, routines off and memories waiting for you to confirm them. An MCP server from the other app only shows up in the summary; it never becomes a connector by itself.

## Backups
In the **Danger area** card › **Backups**:
- The app copies the database once a day and keeps the last 7.
- **Back up now** makes one on the spot. **Open folder** shows where they are.
- Before an update changes the database, the app keeps a copy too.
- Credentials stay encrypted in the backup, tied to this computer's keychain.

Each workspace has its own backups, inside its folder: deleting a workspace deletes its backups. Copy them out first.

## When it goes wrong
- "File too big to send through the browser" (on a server): import in the app on the computer, or export without the files.
- I imported and nothing changed: everything already existed here (the summary says so).
- "This does not look like a Hermes folder": pick the Hermes folder, the one with `SOUL.md` and a `memories` folder (on a server, the server's folder). A folder with only a `config.yaml` or a `skills/`, like `~/.claude`, does not count.
