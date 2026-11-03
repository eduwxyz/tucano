---
name: tucano-export
description: Packs the user's Grok Bot agents into one .zip that Tucano (tucano.sh) imports, with each agent's instructions, picture, skills, scheduled tasks, memories and group chats. Use when the user asks to move, migrate or export their agents to Tucano.
---

# Move my agents to Tucano

Tucano is a desktop app that runs a team of agents on the user's own computer. It has no way to reach
Grok Bot, so you write a `.zip` here and the user opens it in Tucano at **Settings → Team and backup →
Import from another app**.

Tucano refuses the whole file if `tucano-import.json` doesn't follow the format below, so follow it
exactly. Tucano also gives the imported agents no access to anything: the user grants each tool there.
Don't try to carry access, logins or connections over.

## Steps

1. **List what there is.** Find every agent the user has here, except yourself (you only run this
   export) and except this skill. Find the group chats too. Show the user the list and ask which ones
   to bring, all by default. Wait for the answer.

2. **Read each chosen agent.** Collect, when you can read it:
   - its name and a short role (a few words, like "Market research");
   - its full instructions or system prompt, word for word;
   - its picture;
   - its skills, each a folder with a `SKILL.md`;
   - its scheduled tasks: name, the prompt that runs, the days, the time and the time zone;
   - from its past conversations, up to 50 facts worth keeping (see step 3).

   When you can't read a part, leave it out and tell the user at the end. Never fill it in by guessing.

3. **Write the memories.** Each memory is one fact in one sentence, 500 characters or fewer, written as
   a statement: "The user wants reports in BRL.", "The weekly review is on Fridays." Keep preferences,
   names, decisions and open work. Don't copy messages. The user confirms each memory in Tucano before
   an agent uses it.

4. **Take secrets out.** No API keys, tokens, passwords, cookies, private keys or `.env` content
   anywhere: not in instructions, skills or memories. Where an instruction had a secret, write
   `[ask the user]` instead. Leave out of the skill folders any `.env*` file, key file, archive
   (`.zip`, `.tar`, `.gz`), `.git` and `node_modules`.

5. **Build the folder** below, writing `tucano-import.json` last.

6. **Check it** against the checklist, then zip the folder's contents (with `tucano-import.json` at the
   root of the zip, not inside a folder) as `tucano-export-<YYYY-MM-DD>.zip`.

7. **Give the file to the user** in this chat, so they can download it. Then tell them how many agents
   and group chats went in, what you left out and why, and where to open it in Tucano.

## The folder

```
tucano-import.json
agents/<key>/picture.png                  optional: PNG, JPEG or WebP, 140 KB or less
agents/<key>/skills/<skill>/SKILL.md      one folder per skill
```

`<key>` names one agent inside the file: lowercase letters, digits and hyphens, 64 characters or
fewer, not starting or ending with a hyphen, different for each agent (`research`, `sales-desk`).
Every path of an agent starts with `agents/<key>/`.

## tucano-import.json

```json
{
  "format": "tucano-agent-import",
  "version": 1,
  "source": "grok-bot",
  "agents": [
    {
      "key": "research",
      "name": "Research",
      "role": "Market research",
      "instructions": "You look for primary sources and write short briefs with links…",
      "picture": "agents/research/picture.png",
      "skills": ["agents/research/skills/brief"],
      "routines": [
        {
          "name": "Morning news",
          "prompt": "Summarize yesterday's news about our competitors.",
          "days": ["mon", "tue", "wed", "thu", "fri"],
          "time": "08:30",
          "timezone": "America/Sao_Paulo"
        }
      ],
      "memories": ["The user wants reports in BRL."]
    }
  ],
  "channels": [
    { "name": "market-desk", "topic": "Weekly competitor review", "members": ["research"] }
  ]
}
```

| Field | Rule |
| --- | --- |
| `format`, `version`, `source` | Exactly as above. |
| `key` | As described under "The folder". |
| `name` | Required, 80 characters or fewer. |
| `role` | A few words, 80 characters or fewer. |
| `instructions` | The agent's full instructions, word for word, 32,000 characters or fewer. |
| `picture` | A path in the zip, or leave the field out. |
| `skills` | Folder paths. Each `SKILL.md` starts with frontmatter holding `name` and `description`, and its text is 20,000 characters or fewer. Tucano reads only `SKILL.md`. |
| `routines` | `days` uses `sun` `mon` `tue` `wed` `thu` `fri` `sat`; `time` is `HH:MM`, 24 h. Add `"once": true` for a task that runs one time. Tucano can't run tasks every hour, every few minutes or on a day of the month: leave those out and tell the user. |
| `memories` | Strings, 500 characters or fewer each. |
| `channels` | Optional: one per group chat. `name` 80 characters or fewer, `topic` one line, `members` the keys of the agents in it. |

## Checklist

- `tucano-import.json` is valid JSON, at the root of the zip, with `"format": "tucano-agent-import"`
  and `"version": 1`.
- Every key follows the rule and is used by one agent only.
- Every path in the file exists in the zip and starts with its agent's `agents/<key>/`.
- Every routine has `days` and `time`; every channel member is a key in `agents`.
- No secret anywhere, and neither you nor this skill is in the file.
