---
name: tucano-export
description: Writes a .zip that Tucano (tucano.sh) opens to recreate the user's agents from here, with their instructions, pictures, skills, scheduled tasks, remembered facts and group chats. Use when the user wants their agents in Tucano.
---

# Export to Tucano

The user is moving to Tucano, a desktop app where a team of agents runs on their own computer. Tucano
can't connect to this app. What it can do is open one file: a `.zip` holding `tucano-import.json` and a
few files per agent. Your job is to write that file and hand it to the user, who opens it in Tucano at
**Settings → Team and backup → Import from another app**.

Tucano reads only the fields and paths described here and ignores everything else. Logins, tool access
and connections never travel: every imported agent starts in Tucano with no tools, web search off and its
scheduled tasks paused, and the user turns each thing on there. So spend no effort on access.

## What goes in the zip

```
tucano-import.json                        at the root of the zip, not inside a folder
agents/<key>/picture.png                  optional; .png, .jpg or .webp, up to 140 KB
agents/<key>/skills/<name>/SKILL.md       one folder per skill, with only that file in it
```

`<key>` is a short id you choose for each agent, used only inside this file: it starts with a lowercase
letter, then lowercase letters, digits or hyphens, 40 characters at most, and no two agents share one
(`writer`, `ops-2`).

## How to fill each field

Copy, don't compose. Whatever you can't read here, leave out and list in the report you give at the end.

**Agents** (40 at most). For each agent the user wants to bring:

- `key`: as above.
- `name`: the agent's name, up to 80 characters. Required.
- `role`: what it does, in two to five words, up to 80 characters.
- `instructions`: its standing instructions or system prompt, copied exactly with no character limit. Aim for at most 32,000 characters as a recommendation, but never truncate a longer prompt; mention if a newly written prompt exceeds the recommendation.
  If a line holds a password, token, API key or any other credential, drop that line and say so in the
  report. Tucano asks for credentials through its own connectors.
- `picture`: the path of its picture in the zip, when it has one.
- `skills`: the paths of its skill folders (20 at most per agent). Each `SKILL.md` starts with a
  frontmatter block holding `name` and `description`, followed by the recipe. Recipes over 10,000
  characters are imported whole, with a recommendation to shorten them. Tucano reads that file alone,
  so don't copy scripts, data or anything else into the folder.
- `routines`: its scheduled tasks (20 at most per agent), each with `name`, `prompt` (what the task
  asks), `days` (any of `sun mon tue wed thu fri sat`), `time` (`HH:MM`, 24-hour clock) and `timezone`
  (an IANA name, like `Europe/Lisbon`). Add `"once": true` to a task that runs a single time. Tucano runs
  tasks only at a time of day on chosen weekdays: a task that repeats every few minutes or hours, or on a
  date of the month, doesn't fit, so leave it out and report it.
- `memories`: what the agent knows about the user and the work, as plain statements of one fact each,
  up to 300 characters and 40 per agent. Prefer what still matters next month: preferences, people,
  decisions, ongoing projects. Each one waits in Tucano until the user confirms it, so a wrong fact costs
  them a click; a made-up one costs their trust. Never copy a credential into a memory.

**Group chats** (30 at most) go in `channels`: `name` (up to 80 characters), `topic` (one line,
optional) and `members` (the keys of the agents in it). Tucano always makes a new channel for each one.

## Before you write anything

Tell the user which agents and group chats you found and ask which to bring. Unless they say otherwise,
bring them all. Then write the agents' files, and `tucano-import.json` once those are in place.

## Example

```json
{
  "format": "tucano-agent-import",
  "version": 1,
  "source": "grok-bot",
  "agents": [
    {
      "key": "ledger",
      "name": "Ledger",
      "role": "Bookkeeping",
      "instructions": "You match each invoice against the bank statement and flag the ones that don't add up…",
      "picture": "agents/ledger/picture.png",
      "skills": ["agents/ledger/skills/reconcile"],
      "routines": [
        {
          "name": "Unpaid invoices",
          "prompt": "List the invoices still unpaid, with who owes each and since when.",
          "days": ["mon"],
          "time": "17:15",
          "timezone": "Europe/Lisbon"
        }
      ],
      "memories": ["Invoice numbers look like INV-2026-0042."]
    }
  ],
  "channels": [
    { "name": "finance-room", "topic": "Invoices and payments", "members": ["ledger"] }
  ]
}
```

`format`, `version` and `source` stay exactly as in the example. Tucano turns down a file whose
`format` or `version` differs, and skips an agent whose `key` or `name` breaks the rules above.

## Handing it over

Zip the contents of the folder, so `tucano-import.json` sits at the top of the zip, and name it
`tucano-export-<YYYY-MM-DD>.zip`. Send it to the user here as a file they can download.

With it, send a short report: for each agent, what went in (instructions, picture, how many skills,
tasks and memories) and what didn't, with the reason. End with where to open the file in Tucano.
