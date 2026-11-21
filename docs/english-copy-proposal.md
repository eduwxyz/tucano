# English interface copy proposal

Baseline: upstream main `73b724bec8a576d316a5dd5f46a07e3bf83cbe75`, 13 November 2026. Prepared before changing application strings.

## Purpose and boundaries

Make settings and related screens quicker to scan with explicit labels, consistent terminology, and shorter hints. Preserve Portuguese copy, setting keys, defaults, permissions, interpolation syntax, and behavior. Keep privacy disclosures and destructive consequences visible.

## Plan

- [x] Inventory English copy in Settings, agent profiles, Wiki, Memory, Skills, Routines, and onboarding.
- [x] Draft exact replacements with their reason and source location.
- [x] Measure baseline and candidate wrapping in the built interface.
- [x] Implement and verify upstream-compatible replacements.
- [x] Review additional controls on their existing feature PRs.
- [x] Publish the issue and PR with immutable screenshots.
- [x] Validate the built interface with scratch data and fake engines.

## Writing rules

Use sentence case and concrete nouns: model, account, page, approval, and source. Name the object a button changes. Use “automatic” for a mode and “automatically” for an action. Avoid possessives without an object, such as “the memory’s”. Keep scope next to the action: shared workspace context, private sources, and per-agent overrides must remain clear. Do not promise that every action asks for approval when the configured rules allow exceptions.

## Two-line layout target

Measure at 1280 × 900 and 900 × 900 CSS pixels using the shipped fonts and styles. The desktop minimum width is 900 px. Measure each hint’s actual width beside its control, not the outer card width. Count rendered text fragments by baseline with DOM Range rectangles; record font size, line height, characters, and screenshot. Character counts are a drafting guide, not a universal guarantee: proportional fonts and word boundaries change capacity. No line clamp, truncation, or smaller font will hide content. Warnings may exceed two lines when shortening would obscure an important consequence; record those exceptions.

The measurements and before/after captures are added in the validation report. Browser/server captures use the built renderer in a headless browser and scratch data; desktop-only checks use an isolated hidden Electron instance.

## Replacement inventory

223 occurrences proposed below. Identical replacements may occur in more than one control.

### src/renderer/src/components/Pages.tsx

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 2473 | Yours | Your preferences | Name the control or outcome directly. |
| 2501 | What the agents call you | Your name | Name the control or outcome directly. |
| 2516 | See the introduction again | Review introduction | Name the control or outcome directly. |
| 2525 | Show the whole sidebar | Show full sidebar | Name the control or outcome directly. |
| 2229 | Danger area | Danger zone | Name the control or outcome directly. |
| 2230 | Danger area | Danger zone | Name the control or outcome directly. |
| 2660 | Open when the computer starts | Launch at login | Name the control or outcome directly. |
| 2639 | What it learns about you | Memory learning | Name the control or outcome directly. |
| 2644 | A suggestion for you to approve | Ask for approval | Name the control or outcome directly. |
| 2645 | Saved on its own | Save automatically | Name the control or outcome directly. |
| 2646 | Nothing (just summarizes) | Summaries only | Name the control or outcome directly. |
| 2709 | Treat as stuck after (min with no sign) | Inactivity timeout (minutes) | Name the control or outcome directly. |
| 2716 | Agent replies in a row | Consecutive agent replies | Name the control or outcome directly. |
| 2693 | Default limit per agent (millions of tokens/month) | Monthly limit per agent (million tokens) | Name the control or outcome directly. |
| 2701 | Limit per reply (% of the monthly limit) | Reply limit (% of monthly limit) | Name the control or outcome directly. |
| 723 | Where it runs and model | Runtime and model | Name the control or outcome directly. |
| 429 | Where it takes part | Channels | Name the control or outcome directly. |
| 409 | Look | Appearance | Name the control or outcome directly. |
| 252 | Saves on its own | Save automatically | Name the control or outcome directly. |
| 253 | Asks for approval | Ask for approval | Name the control or outcome directly. |
| 254 | Read only | Read-only | Name the control or outcome directly. |
| 1051 | Read only | Read-only | Name the control or outcome directly. |
| 2441 | Path to whisper-cli | whisper-cli path | Name the control or outcome directly. |
| 2444 | Path to the model | Model path | Name the control or outcome directly. |
| 2423 | Remove the model | Remove model | Name the control or outcome directly. |
| 2439 | Detect the language, instead of using the app’s | Detect spoken language | Name the control or outcome directly. |
| 2433 | Show the microphone in the message field | Show microphone in composer | Name the control or outcome directly. |
| 2770 | Test | Test notifications | Name the control or outcome directly. |
| 2775 | Send one | Send test | Name the control or outcome directly. |
| 1128 | Fine-tune action by action | Action rules | Name the control or outcome directly. |
| 1117 | After reading something from outside, ask before what can’t be undone | Confirm actions after reading external content | Name the control or outcome directly. |
| 2612 | Only by the page’s text | Page text only | Name the control or outcome directly. |
| 388 | How you call and recognize the agent in chat. | The agent’s name and appearance in chat. | Name the control or outcome directly. |
| 345 | Takes it out of the sidebar and it stops replying; you can reactivate it | Hide this agent and stop its replies. You can reactivate it. | Name the control or outcome directly. |
| 685 | See in Memory | Open Memory | Name the control or outcome directly. |
| 1250 | See in the conversation | View in conversation | Name the control or outcome directly. |
| 1303 | See in the conversation | View in conversation | Name the control or outcome directly. |
| 1345 | Requests for an admin to apply | Requests for an admin | Name the control or outcome directly. |
| 1362 | You asked, waiting on someone else | Your pending requests | Name the control or outcome directly. |
| 2473 | How Tucano looks to you. It changes only for you. | These appearance settings apply only to you. | Keep behavior and scope; remove repeated instructions. |
| 2477 | The app’s language for you. The agents reply in the Tucano’s language. | Your interface language. Agents use the workspace language. | Keep behavior and scope; remove repeated instructions. |
| 2489 | Only an admin changes the models, the agents, the context and the Tucano’s other settings. | Only admins can change models, agents, context, and workspace settings. | Keep behavior and scope; remove repeated instructions. |
| 2494 | Agents, conversations, connectors and memories stay in this workspace. Claude Code and OpenCode sign-ins are still shared on this computer. A workspace is not an OS sandbox. | Workspace data is separate; Claude Code and OpenCode logins are shared. Workspaces are not sandboxes. | Keep behavior and scope; remove repeated instructions. |
| 2508 | The app’s language, and the one the agents reply in. | Language for the interface and agent replies. | Keep behavior and scope; remove repeated instructions. |
| 2510 | Goes into every conversation of every agent: who you are, what you do, what matters now and what never to do. | Shared with every agent: your role, priorities, and rules. | Keep behavior and scope; remove repeated instructions. |
| 2540 | The chirp when an agent needs you and when it’s done. Off, notifications still show up, silently. | Play a sound when agents need you or finish. Notifications remain visible when muted. | Keep behavior and scope; remove repeated instructions. |
| 2559 | The programs the agents run on, each one the way you set it up: on your plan, your company’s gateway or your providers. Tucano never sees or stores your credentials. | Run agents through your existing plans, gateway, or providers. Tucano does not access or store harness credentials. | Keep behavior and scope; remove repeated instructions. |
| 2576 | More than one Claude Code or Codex login, like a work account and a personal one. Each agent picks its account on its page. You sign in through the CLI itself: Tucano never sees or stores the password. | Add Claude Code or Codex accounts, then assign them to agents. Sign in through the CLI; Tucano never stores your password. | Keep behavior and scope; remove repeated instructions. |
| 2586 | A small model that reads the conversation and decides who replies in channels. It grants no permissions at all. | Choose who replies in channels. The router cannot grant permissions. | Keep behavior and scope; remove repeated instructions. |
| 2587 | Go for a fast model: it runs before every reply in a channel. | Use a fast model; it runs before each channel reply. | Keep behavior and scope; remove repeated instructions. |
| 2598 | For every agent: how far they go on their own and what asks for your approval first, with a button in the conversation. On each agent’s page you can change it for that agent only. Reading and looking into things never asks. | Default approval rules for all agents; override them on each agent’s page. Reading never needs approval. | Keep behavior and scope; remove repeated instructions. |
| 2608 | How the app finds what the agent asks to click (“the Search button”). By text it’s free and handles most cases; when it can’t find it, the agent uses the element’s number. | Find controls by page text at no cost. If no match is found, agents use element numbers. | Keep behavior and scope; remove repeated instructions. |
| 2620 | Finds the element in under 1 second, even without text (from the screenshot). But every click text can’t resolve sends TypeSafe the page’s element list and sometimes its screenshot, including signed-in areas. | When text matching fails, TypeSafe receives page elements and may receive screenshots, including signed-in content. | Keep behavior and scope; remove repeated instructions. |
| 2634 | A small model summarizes what leaves each conversation’s window and, from the same stretch, picks what’s worth remembering about you. | Summarize older messages and extract lasting facts about you. | Keep behavior and scope; remove repeated instructions. |
| 2636 | Runs every ~20 messages in a long conversation. | Runs about every 20 messages in long conversations. | Keep behavior and scope; remove repeated instructions. |
| 2639 | Only what you said counts, never what an agent assumed. | Learns from your messages, not agent assumptions. | Keep behavior and scope; remove repeated instructions. |
| 2656 | Routines run while the app is open, even with the window closed. | Routines require Tucano to keep running, even with its window closed. | Keep behavior and scope; remove repeated instructions. |
| 2661 | So no routine depends on you remembering to open the app. | Start Tucano automatically so routines can run. | Keep behavior and scope; remove repeated instructions. |
| 2661 | Only in the installed app. Running with npm run dev, it stays off. | Available in the installed app; disabled in development. | Keep behavior and scope; remove repeated instructions. |
| 2665 | Opening at login is an app setting: change it in the default workspace. All workspaces start together. | Change login startup in the default workspace. All workspaces start together. | Keep behavior and scope; remove repeated instructions. |
| 2670 | Routines and triggers wait and run when it ends (as late ones). What you send still gets answered. | Defer routines and triggers until quiet hours end. Direct messages still get replies. | Keep behavior and scope; remove repeated instructions. |
| 2701 | When it hits it, the agent pauses and you decide whether it continues. | Pause at the limit and ask you whether to continue. | Keep behavior and scope; remove repeated instructions. |
| 2709 | No text and no tool finishing. Long work that’s moving isn’t cut off. | Stop after no text or completed tools. Work that shows progress continues. | Keep behavior and scope; remove repeated instructions. |
| 2716 | How many replies agents can give in a row, passing the turn between them, before they stop and wait for you. From 1 to 10. | Allow 1–10 agent replies before waiting for you. | Keep behavior and scope; remove repeated instructions. |
| 2771 | Sends a notification now, to see that it comes. | Send a test to check notification delivery. | Keep behavior and scope; remove repeated instructions. |
| 2441 | Optional: without it, the app uses the one it came with. | Optional. Defaults to the bundled executable. | Keep behavior and scope; remove repeated instructions. |
| 2444 | Optional: a ggml model (.bin) you already have. | Optional path to an existing ggml model (.bin). | Keep behavior and scope; remove repeated instructions. |
| 2403 | Speak instead of typing: click the microphone in the message field, or ⌥ Space on a Mac and Ctrl+Space elsewhere, and click again to finish. The audio becomes text on this computer, offline, and the text stays in the field for you to review before sending. | Click the mic or press ⌥ Space (Mac) / Ctrl+Space to start; click again to stop. Transcription stays offline for review before sending. | Keep behavior and scope; remove repeated instructions. |
| 2286 | Phone (Telegram) | Telegram | Keep behavior and scope; remove repeated instructions. |
| 2286 | Approvals with buttons, the agents’ questions (just reply to the message) and routine results, in your Telegram. Handy for a routine that asks for approval in the middle of the night. | Receive approvals, questions, and routine results in Telegram. Use buttons to approve, or reply to answer. | Keep behavior and scope; remove repeated instructions. |
| 2312 | Only whoever sends this code gets the bot. Waiting… | Waiting for this code in Telegram. Only the sender can pair. | Keep behavior and scope; remove repeated instructions. |
| 2342 | Telegram receives the text of approvals and questions (tool, arguments, reason) and the routines’ replies. The token stays in the system’s vault. A high-risk action takes two taps. | Telegram receives approval details, questions, and routine replies. The token stays in the system vault. High-risk actions need two taps. | Keep behavior and scope; remove repeated instructions. |
| 2233 | Make a copy before deleting data. Automatic backup keeps the last 7 daily copies. | Back up before deleting data. Automatic backups retain the last 7 daily copies. | Keep behavior and scope; remove repeated instructions. |
| 234 | That image didn't open. Try another one, in PNG or JPG. | Could not open this image. Choose a PNG or JPG. | Keep behavior and scope; remove repeated instructions. |
| 402 | One line. It helps decide who replies in channels. | One line to help route channel replies. | Keep behavior and scope; remove repeated instructions. |
| 416 | Write it as you would for a new colleague: what to do, what to avoid, when to ask. | Describe the agent’s tasks, limits, and when to ask for help. | Keep behavior and scope; remove repeated instructions. |
| 423 | The workspace context already goes into every conversation. Here goes only what’s specific to this agent. | Workspace context is already included. Add only agent-specific instructions. | Keep behavior and scope; remove repeated instructions. |
| 456 | One level per connector. What’s left out doesn’t even reach the model. | Set access per connector. Unavailable tools are hidden from the model. | Keep behavior and scope; remove repeated instructions. |
| 456 |  Takes effect right away, no need to save. |  Applies immediately. | Keep behavior and scope; remove repeated instructions. |
| 563 |  Takes effect right away, no need to save. |  Applies immediately. | Keep behavior and scope; remove repeated instructions. |
| 576 |  Takes effect right away, no need to save. |  Applies immediately. | Keep behavior and scope; remove repeated instructions. |
| 596 |  Takes effect right away, no need to save. |  Applies immediately. | Keep behavior and scope; remove repeated instructions. |
| 637 |  Takes effect right away, no need to save. |  Applies immediately. | Keep behavior and scope; remove repeated instructions. |
| 658 |  Takes effect right away, no need to save. |  Applies immediately. | Keep behavior and scope; remove repeated instructions. |
| 576 | Searches and reads pages with Claude Code’s or Codex’s own tool, on your subscription. Every search shows up in the reply’s steps. | Search the web through Claude Code or Codex on your plan. Searches appear in the reply’s steps. | Keep behavior and scope; remove repeated instructions. |
| 658 | Memories about you apply to every agent; work notes are its own. | All agents share memories about you. Work notes belong to this agent. | Keep behavior and scope; remove repeated instructions. |
| 695 | The wiki is what you and the team know, as pages. With access, the agent looks there before replying and cites the pages. | Agents with access consult shared wiki pages before replying and cite their sources. | Keep behavior and scope; remove repeated instructions. |
| 723 | The agent runs in Claude Code, Codex or another one you already use, the way you set it up: on your plan, your company’s gateway or your provider. | Use Claude Code, Codex, or another configured runtime with your plan, gateway, or provider. | Keep behavior and scope; remove repeated instructions. |
| 749 | More effort thinks longer and uses more of your plan. | Higher effort takes more time and uses more of your plan. | Keep behavior and scope; remove repeated instructions. |
| 767 | How many routines the agent can have enabled at the same time. | Maximum routines enabled for this agent at once. | Keep behavior and scope; remove repeated instructions. |
| 1833 | Whoever is above hands work to those below, in each one’s channel, and gets the answer back. With no one set, everything works as it always did. | Managers delegate work in each agent’s channel and receive the results. Leave unset for independent agents. | Keep behavior and scope; remove repeated instructions. |
| 1919 | This account isn’t signed in yet: the reserve only works once you sign in under Settings › Models. | Sign in under Settings › Models to enable this fallback account. | Keep behavior and scope; remove repeated instructions. |
| 1925 | It’s the same model, on the same account as the main one: the reserve won’t be used. | The fallback uses the same model and account, so it will not be used. | Keep behavior and scope; remove repeated instructions. |
| 1926 | It’s the same program, on the same account as the main one: if the limit is the subscription’s, it’ll be out too. | The fallback shares this account’s subscription limit. Choose a different account or runtime. | Keep behavior and scope; remove repeated instructions. |
| 494 | No tools exposed | No tools available | Keep behavior and scope; remove repeated instructions. |
| 1231 | Nothing sensitive happens without you. Each approval covers one exact action. | Review requests for sensitive actions. Each approval covers one specific action. | Keep behavior and scope; remove repeated instructions. |
| 1236 | When an agent wants to publish code, put something live, delete or send something out, the request shows up here and in the conversation. | Requests to publish, deploy, delete, or send appear here and in the conversation. | Keep behavior and scope; remove repeated instructions. |
| 1309 | What waits on you: approvals you decide and the agents’ questions to you. | Approval requests and questions from your agents. | Keep behavior and scope; remove repeated instructions. |
| 1314 | When an agent needs your approval or asks you something, it shows up here and in the conversation. | New approval requests and questions appear here and in the conversation. | Keep behavior and scope; remove repeated instructions. |
| 1452 | The services the team’s agents work with. Every call goes through permissions and approvals. | Services your team’s agents can use, subject to permissions and approval rules. | Keep behavior and scope; remove repeated instructions. |
| 1565 | The agents lose access to its tools. To get it back, just add the connector again. | Agents lose access to these tools. Add the connector again to restore access. | Keep behavior and scope; remove repeated instructions. |
| 1612 | New tools the server publishes later come in off until you review them. Sensitive ones always ask for approval. | New tools stay disabled until reviewed. Sensitive tools require approval. | Keep behavior and scope; remove repeated instructions. |
| 1752 | Create one or bring it from Claude Code | Create a skill or import one from Claude Code | Keep behavior and scope; remove repeated instructions. |
| 2007 | File too big to send through the browser. Import it in the desktop app, or export without the files. | This file exceeds the browser upload limit. Use the desktop app or export without files. | Keep behavior and scope; remove repeated instructions. |
| 1893 | `When the main model’s subscription hits its limit (the 5-hour or the weekly one), the reply goes on with the reserve, which can be in another program (Claude Code, Codex…) or another account. On the next reply, ${draft.name \|\| 'the agent'} tries the main one again.` | `Continue on a fallback account or runtime when a subscription limit is reached. ${draft.name \|\| 'The agent'} retries the main model next reply.` | Preserve fallback timing and account/runtime options. |
| 1914 | `${ENGINES[reserve.engine].label}’s usual one` | `Default ${ENGINES[reserve.engine].label} account` | Name the account rather than an unnamed possessive. |
| 1917 | `${ENGINES[reserve.engine].label}’s usual one` | `Default ${ENGINES[reserve.engine].label} account` | Name the account rather than an unnamed possessive. |

### src/renderer/src/components/Wiki.tsx

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 1078 | The curator | Curator | Use concrete wiki terms and concise actions. |
| 1081 | Keep from conversations | Capture conversations | Use concrete wiki terms and concise actions. |
| 1088 | Changing a page that exists | Existing page edits | Use concrete wiki terms and concise actions. |
| 1093 | Asks first | Ask for approval | Use concrete wiki terms and concise actions. |
| 1102 | Review on its own every week | Weekly review | Use concrete wiki terms and concise actions. |
| 1110 | The folder | Storage folder | Use concrete wiki terms and concise actions. |
| 1169 | The rules | Page rules | Use concrete wiki terms and concise actions. |
| 1152 | Bring what you already have | Import | Use concrete wiki terms and concise actions. |
| 1020 | Recently touched | Recently updated | Use concrete wiki terms and concise actions. |
| 970 | Review what came in | Review imported pages | Use concrete wiki terms and concise actions. |
| 967 | See the map | View map | Use concrete wiki terms and concise actions. |
| 1222 | Sync with git | Sync with Git | Use concrete wiki terms and concise actions. |
| 1310 | Sync with git | Sync with Git | Use concrete wiki terms and concise actions. |
| 1239 | Synced with git | Synced with Git | Use concrete wiki terms and concise actions. |
| 1287 | Disconnect from git? | Disconnect from Git? | Use concrete wiki terms and concise actions. |
| 1280 | The repository's keys | Repository keys | Use concrete wiki terms and concise actions. |
| 1376 | Merge with these | Merge local pages | Use concrete wiki terms and concise actions. |
| 1438 | Swaps in | Replaces text in | Use concrete wiki terms and concise actions. |
| 1447 | Out | Removed | Use concrete wiki terms and concise actions. |
| 1452 | In | Added | Use concrete wiki terms and concise actions. |
| 1467 | Went in | Applied | Use concrete wiki terms and concise actions. |
| 1467 | Refused | Rejected | Use concrete wiki terms and concise actions. |
| 1510 | Refuse | Reject | Use concrete wiki terms and concise actions. |
| 1485 | where it came from | source | Use concrete wiki terms and concise actions. |
| 2064 | Where it came from | Sources | Use concrete wiki terms and concise actions. |
| 1500 | Redo on the newer version | Regenerate change | Use concrete wiki terms and concise actions. |
| 1583 | Don't agree | Conflicting facts | Use concrete wiki terms and concise actions. |
| 1627 | Don't agree | Conflicting facts | Use concrete wiki terms and concise actions. |
| 1589 | Nothing links to them | Unlinked pages | Use concrete wiki terms and concise actions. |
| 1590 | Reads like a log | Excessive history | Use concrete wiki terms and concise actions. |
| 1630 | Reads like a log | Excessive history | Use concrete wiki terms and concise actions. |
| 1631 | Loose | Unresolved links | Use concrete wiki terms and concise actions. |
| 1587 | Page to write | Missing page | Use concrete wiki terms and concise actions. |
| 1588 | No page | Missing page | Use concrete wiki terms and concise actions. |
| 1647 | All in order. Nothing to look after now. | No open findings. | Use concrete wiki terms and concise actions. |
| 1666 | Leave it | Dismiss | Use concrete wiki terms and concise actions. |
| 1767 | A file | File | Use concrete wiki terms and concise actions. |
| 1777 | A link | Link | Use concrete wiki terms and concise actions. |
| 1791 | A note | Note | Use concrete wiki terms and concise actions. |
| 1781 | Bring | Import | Use concrete wiki terms and concise actions. |
| 1795 | Keep | Save | Use concrete wiki terms and concise actions. |
| 1950 | Keep | Save | Use concrete wiki terms and concise actions. |
| 1953 | See | View | Use concrete wiki terms and concise actions. |
| 1930 | Kept in the wiki | Saved to wiki | Use concrete wiki terms and concise actions. |
| 1930 | Wants to keep in the wiki | Proposed wiki change | Use concrete wiki terms and concise actions. |
| 1979 | Keeping… | Saving… | Use concrete wiki terms and concise actions. |
| 1979 | Nothing to keep | Nothing to save | Use concrete wiki terms and concise actions. |
| 1979 | Keep in the wiki | Save to wiki | Use concrete wiki terms and concise actions. |
| 2184 | another kind… | Other type… | Use concrete wiki terms and concise actions. |
| 1903 | Delete for good (the pages stay) | Delete permanently (keep pages) | Use concrete wiki terms and concise actions. |
| 1082 | Once a conversation settles, it keeps the decisions, facts and results in the pages. It can be turned off per channel or DM, from the conversation menu. | Save decisions, facts, and results to wiki pages. Disable per channel or DM in its menu. | Keep scope and effects while shortening guidance. |
| 1089 | New pages always go in right away. On automatic, what was already waiting goes in too. It all stays in the history, with Undo. | New pages save immediately. Automatic also applies pending edits. Undo from History. | Keep scope and effects while shortening guidance. |
| 1103 | Looks for what disagrees, what got old and what repeats. What it finds waits for you in Care. | Find conflicts, outdated facts, and duplicates in Care. | Keep scope and effects while shortening guidance. |
| 1115 | Plain Markdown: it opens in Obsidian, goes to iCloud or git. It can be your Obsidian vault. | Markdown files, compatible with Obsidian, iCloud, and Git. | Keep scope and effects while shortening guidance. |
| 1143 | Back to Tucano's folder | Use default folder | Keep scope and effects while shortening guidance. |
| 1159 | The notes come in as they are, with their folders, links and attachments. The original vault stays as it was. | Copy notes, folders, links, and attachments. The original vault stays unchanged. | Keep scope and effects while shortening guidance. |
| 1158 | Zip the vault’s folder and send it: the notes come in as they are, with their folders, links and attachments. | Upload a zipped vault to copy its notes, folders, links, and attachments. | Keep scope and effects while shortening guidance. |
| 1173 | The kinds of page and how to write. The agents and the curator follow this page. | Page types and writing rules for agents and the curator. | Keep scope and effects while shortening guidance. |
| 1223 | The wiki becomes a clone of your repository (your Obsidian vault on GitHub, say): what changes there shows up here, and what changes here goes there. | Use a repository as your wiki. Changes sync both ways. | Keep scope and effects while shortening guidance. |
| 888 | Everything you know, in one place | Shared knowledge, linked together | Keep scope and effects while shortening guidance. |
| 890 | People, clients, projects, decisions. Each page links to the others, and the agents read it all before replying. You write it, or let the curator write it from the conversations and the documents you bring. | Link people, projects, and decisions. Write pages yourself or let the curator use your conversations and documents. Agents consult them before replying. | Keep scope and effects while shortening guidance. |
| 903 | Already have an Obsidian vault? It comes in as it is, with folders, links and attachments. The original stays where it is. | Import an Obsidian vault with its folders, links, and attachments. The original stays unchanged. | Keep scope and effects while shortening guidance. |
| 916 | Bringing the notes in… | Importing notes… | Keep scope and effects while shortening guidance. |
| 961 | The agents already read these pages and cite them in their replies. The original vault is unchanged. | Agents can now read and cite these pages. The original vault is unchanged. | Keep scope and effects while shortening guidance. |
| 1453 | Nothing in its place: the passage just leaves the page. | This passage will be removed without replacement. | Keep scope and effects while shortening guidance. |
| 1498 | The page changed after this suggestion. The curator makes the change again on the newer version, keeping what changed. | This page has changed. Regenerate the suggestion against its latest version. | Keep scope and effects while shortening guidance. |
| 1552 | What the curator wants to change in pages that already exist. Approve, refuse, or change how it works in the settings. | Review proposed edits to existing pages. Approve or reject them, or change approval rules in Wiki settings. | Keep scope and effects while shortening guidance. |
| 1627 | Two pages saying different things about the same amount, date or deadline. | Pages disagree about an amount, date, or deadline. | Keep scope and effects while shortening guidance. |
| 1629 | Two pages about the same person or project. It merges them, losing nothing. | Merge duplicate pages about the same person or project, preserving their content. | Keep scope and effects while shortening guidance. |
| 1630 | A history that turned into a diary of what was done. It condenses it into what holds today. | Condense activity logs into the facts that still apply. | Keep scope and effects while shortening guidance. |
| 1631 | Links to missing pages, names with no page, pages nothing cites. | Missing pages, unresolved names, and unlinked pages. | Keep scope and effects while shortening guidance. |
| 1819 | What the wiki is made from. The curator reads each source and writes in the pages, citing where it came from. | The curator uses these sources to write pages with citations. | Keep scope and effects while shortening guidance. |
| 1878 | It came from someone's private conversation: only they read what it says. You can delete the source, along with the changes made from it. | Private to its author. Deleting this source removes its change history; existing pages stay. | Keep scope and effects while shortening guidance. |
| 2160 | Markdown. Link pages with [[Title]]; one that doesn't exist yet becomes an invitation to write it. | Use Markdown and [[Page title]] links. Missing links let you create a page. | Keep scope and effects while shortening guidance. |
| 2160 | The wiki rules: the kinds of page and how to write. The agents and the curator follow this page. | Page types and writing rules for agents and the curator. | Keep scope and effects while shortening guidance. |
| 2190 | Start with one sentence that says what it is. Then sections with ##. | Start with a one-sentence summary. Use ## for section headings. | Keep scope and effects while shortening guidance. |
| 2197 | The preview shows up here. | Preview appears here. | Keep scope and effects while shortening guidance. |
| 774 | Tucano's key only reads the git repository: the wiki shows what's there and takes no writes. | The repository key is read-only. Wiki editing is disabled. | Keep scope and effects while shortening guidance. |
| 1373 | The wiki shows only what is in the repository. The pages here stay in the old folder, as a backup. | Show repository pages only. Keep local pages in the old folder as a backup. | Keep scope and effects while shortening guidance. |
| 1377 | The pages here go into the repository. Nothing there is overwritten: a page with the same name comes in as "(Tucano’s version)". | Add local pages without overwriting repository pages. Name conflicts use “(Tucano’s version)”. | Keep scope and effects while shortening guidance. |
| 1288 | The wiki stops syncing and Tucano deletes its key. The folder stays as it is, with the pages. In the repository, delete the deploy key too. | Stop syncing and delete Tucano’s key. Local pages stay. Also remove the deploy key from the repository. | Keep scope and effects while shortening guidance. |

### src/renderer/src/components/Memory.tsx

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 103 | They only go into memory if you keep them. | Save a suggestion to add it to memory. | Clarify memory states and actions. |
| 136 | Out of the prompt. The record keeps them from being learned again; deleting for good removes even that. | Excluded from prompts and blocked from relearning. Permanent deletion also removes that block. | Clarify memory states and actions. |
| 207 | Out of the prompt: agents find it with buscar_memorias. | Not included in prompts; agents can find it through memory search. | Clarify memory states and actions. |
| 207 |  · by search |  · searchable | Clarify memory states and actions. |
| 223 | Hide the previous one | Hide previous version | Clarify memory states and actions. |
| 223 | See the previous one | View previous version | Clarify memory states and actions. |
| 295 | Enter keeps it | Enter to save | Clarify memory states and actions. |
| 140 | Delete for good | Delete permanently | Clarify memory states and actions. |

### src/renderer/src/components/Skills.tsx

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 90 | From the agents. They only go into use if you approve. | Agent proposals become available after your approval. | Use consistent task and version terminology. |
| 100 | Recipes the agents follow for a kind of task. | Reusable instructions for specific tasks. | Use consistent task and version terminology. |
| 127 | Write one, bring one you already use in the terminal, or let the agents propose: when they solve something in several steps, they suggest keeping the path. | Create a skill, import one from your CLI, or review reusable workflows proposed by agents. | Use consistent task and version terminology. |
| 226 | How it’s going | Performance | Use consistent task and version terminology. |
| 215 | Who uses it | Assigned agents | Use consistent task and version terminology. |
| 543 | Who uses it | Assigned agents | Use consistent task and version terminology. |
| 359 | Who uses it? | Assign agents | Use consistent task and version terminology. |
| 248 | Recipe | Instructions | Use consistent task and version terminology. |
| 537 | Recipe | Instructions | Use consistent task and version terminology. |
| 363 | Read straight from the file: what you change in it applies next time. | Read from the source file on each use. File edits apply next time. | Use consistent task and version terminology. |
| 358 | It has scripts: it only runs with an agent that has a computer (Linux or this computer). | Scripts require an agent with computer access (Linux or this computer). | Use consistent task and version terminology. |
| 391 | Only some | Selected agents | Use consistent task and version terminology. |
| 433 | Restore this one | Restore version | Use consistent task and version terminology. |
| 468 | After approving, you can open it to other agents. | After approval, you can assign it to more agents. | Use consistent task and version terminology. |
| 547 | The current version stays in the history: you can go back. | The current version stays in History for restoration. | Use consistent task and version terminology. |

### src/renderer/src/components/Routines.tsx

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 197 | Show only one agent’s | Filter routines by agent | State the filter target. |
| 224 | Watching, no set time | Event-triggered routines | State the filter target. |
| 188 | back to this week | Back to this week | State the filter target. |

### src/renderer/src/components/Intro.tsx

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 944 | Who replies decides which agent speaks in a channel; the memory sums up long talks. A quick model is enough. You can change them later in Settings. | The router chooses who replies in channels. The memory model summarizes long conversations. Use fast models; change them later in Settings. | Name background jobs explicitly. |
| 512 | I already picked the quick models for behind the scenes. To change them, it’s down there. | Fast models are selected for background tasks. You can change them below. | Name background jobs explicitly. |

### src/shared/actions.ts

| Source line | Current English | Proposed English | Reason |
| --- | --- | --- | --- |
| 68 | Asks first | Ask first | Keep approval terminology consistent. |
| 68 | Does it alone | Automatic | Keep approval terminology consistent. |
| 35 | A risky click in the browser | Risky browser clicks | Keep approval terminology consistent. |
| 36 | A risky action in an app | Risky app actions | Keep approval terminology consistent. |
| 92 | Asks before anything that changes something: writing in a connector, a commit, a push, a risky click. | Ask before changes, including connector writes, commits, pushes, and risky clicks. | Keep approval terminology consistent. |
| 93 | Reads and writes on its own; asks before what’s sensitive: sending, deleting, publishing, paying, a risky click. | Allow reads and writes; ask before sending, deleting, publishing, paying, or risky clicks. | Keep approval terminology consistent. |
| 94 | Does everything on its own, without asking. What you marked high risk still asks. | Act without approval, except for tools marked high risk. | Keep approval terminology consistent. |

## Retained detail and review notes

Full backup/restore and workspace deletion warnings retain their detailed consequences. External-service disclosures keep the destination and data sent. Existing brand names, CLI commands, file formats, keyboard shortcuts, and settings values remain exact. “Care” remains the Wiki destination name so existing navigation still matches the hints. Generic Save/Cancel buttons remain where the dialog already names the object.

## Baseline layout evidence

Built upstream renderer, headless Edge, Inter Variable, default text size. The same text sample is repeated until a third rendered line appears; the last two-line prefix is the reported character capacity. These capacities describe that sample at that width, not every possible string.

| Context | Viewport | Available width | Font / line height | Sample characters in two lines |
| --- | --- | --- | --- | --- |
| general | 1280 px | 678 px | 13px / 20.15px | 203 |
| models | 1280 px | 678 px | 13px / 20.15px | 203 |
| agents | 1280 px | 333 px | 12px / 18.6px | 116 |
| phone | 1280 px | 678 px | 13px / 20.15px | 203 |
| wiki | 1280 px | 327.2 px | 12.5px / 18.125px | 116 |
| general | 900 px | 538 px | 13px / 20.15px | 162 |
| models | 900 px | 538 px | 13px / 20.15px | 162 |
| agents | 900 px | 263 px | 12px / 18.6px | 88 |
| phone | 900 px | 538 px | 13px / 20.15px | 162 |
| wiki | 900 px | 327.2 px | 12.5px / 18.125px | 116 |

Measured examples: the 256-character Dictation hint takes three lines; the 122-character consecutive-replies hint takes three lines at a 263 px text width; the 126-character Wiki edit hint takes three lines at 327.2 px. The Wiki dialog is 560 px wide, but its edit-mode control leaves much less room for the hint. Baseline screenshots are retained with the audit report; final comparison links follow after implementation.

### Additional replacements after baseline inspection

| Current English | Proposed English | Reason |
| --- | --- | --- |
| An email, a page or an issue can carry instructions someone else wrote. With this on, after reading something like that, sending, publishing, paying, deleting and risky clicks ask for your approval, even where a rule lets it do them alone. | After reading external content, sending, publishing, paying, deleting, and risky clicks need approval, even if a rule allows them. | Preserve the external-content guard and its override of automatic action rules. |
| With the guard below on, what can’t be undone after reading something from outside asks too. | The external-content guard still requires approval for consequential actions. | Keep the additional guard exception visible. |
| The team in a .md file (agents, skills, channels and routines, without credentials or conversations), to keep or take to another computer. Agents from OpenBot and Grok Bot come in too, with no connector and web search off. | Export agents, skills, channels, and routines as Markdown, without credentials or chats. Import OpenBot or Grok Bot agents with connectors and search off. | Keep export content, exclusions, and safe import defaults. |
| Kept in the system’s vault. | Stored in the system vault. | Use standard storage terminology. |

## Wider interface pass

Reviewed all localized strings in renderer components and shared UI helpers. Model-facing starter prompts, user-authored content, and provider setup procedures are outside this copy edit. Long provider instructions retain their steps and security warnings. Additional replacements below were recorded before implementation.

| Location | Current English | Proposed English |
| --- | --- | --- |
| AgentModelsPanel.tsx:52 | When switching harnesses, the agent uses its default login. The reserve model stays the same. | Switching runtimes uses the default login. The fallback model stays unchanged. |
| Dialogs.tsx:144 | One line at the top of the channel saying what it is for. Empty, it goes away. | One-line channel description. Leave empty to hide it. |
| Dialogs.tsx:264 | 2. After you allow it, come back here: Tucano connects on its own and this closes. | 2. After authorization, return here. Tucano connects and closes this dialog. |
| Dialogs.tsx:272 | After you allow it, the browser goes to an address starting with http://127.0.0.1 and says the page can’t be reached. That’s expected: Tucano is on the server. Copy the whole address from the bar and paste it here. | After authorization, a 127.0.0.1 page may fail to load because Tucano runs on a server. Copy the full address and paste it here. |
| Harness.tsx:291 | Installing in the terminal that opened. Once it finishes, it shows up here on its own. | Complete installation in the terminal. Tucano detects it automatically. |
| People.tsx:140 | Who has access to this Tucano and what each one can do. Each person’s DMs are theirs alone. | Manage workspace access and roles. Each person’s DMs remain private. |
| People.tsx:305 | The link works once, for 7 days. Whoever uses it comes in with their own name, in the browser or the app. | A single-use link, valid for 7 days. Invitees join under their own name in the browser or app. |
| People.tsx:529 | While you’re away, someone answers the questions and decides the approvals that would be yours. | Choose who handles your questions and approvals while you are away. |
| People.tsx:654 | Who did what in this Tucano. What’s said in DMs never shows here. | Workspace activity. Private DM content is excluded. |
| Servers.tsx:44 | Only this computer forgets the access. The Tucano on the server stays there, with everything. | Remove access from this computer. The server and its data stay unchanged. |
| Servers.tsx:55 | A Tucano running on a server, always on, opened right here: pick it in the list at the top of the sidebar, and come back from the bar above it. The agents and conversations are the server’s; nothing on this computer goes to it. | Open a server workspace from the sidebar switcher; return with the bar above it. Its data stays on the server. Your local workspace is not uploaded. |
| Servers.tsx:87 | Paste the connection link the server gave you (tucano://connect…, or the browser sign-in link, with ?code=). Whoever has the link controls the agents there: paste only links of your own or from someone you trust. | Paste a trusted tucano://connect… or ?code= sign-in link. Anyone with it can control the server’s agents. |
| Update.tsx:83 | Couldn’t update on its own. Download the new version from Releases. | Automatic update failed. Download the latest version from Releases. |
| Update.tsx:85 | No internet to look for a new version. Tucano tries again on its own later. | Could not check for updates while offline. Tucano will retry automatically. |
| Update.tsx:76 | Looking for a new version… | Checking for updates… |
| WorkspaceManager.tsx:11 | The text that goes in every conversation: who you are, what you do, what matters. | Shared instructions included in every conversation. |
| WorkspaceManager.tsx:12 | The same wiki, not a copy: what one workspace keeps the other reads. Without it, it starts with an empty wiki. | Share the same wiki folder across both workspaces. Otherwise, start with an empty wiki. |
| Conversation.tsx:876 | Once the thread is quiet for a few minutes, what was said becomes a summary here, and the memories about you come from it. | After a few quiet minutes, this thread is summarized and personal memories are extracted. |
| Conversation.tsx:955 | its own note | agent note |
| Conversation.tsx:984 | waiting on an answer | awaiting an answer |
| Conversation.tsx:1001 | what this thread ends with goes back to whoever asked | The final result is returned to the requester. |
| Pages.tsx:1891 | Reserve model | Fallback model |
| Pages.tsx:1909 | Reserve account | Fallback account |
| Pages.tsx:1927 |  Pick another one under “Reserve account”. |  Choose another account under “Fallback account”. |
| Pages.tsx:596 | A Chrome of its own: opens pages, clicks, fills in and reads like a person, with logins separate from yours (you sign in via Take over). A click that buys, publishes, sends or deletes asks for your approval. | A separate Chrome profile for browsing and forms. Sign in via Take over. Buying, publishing, sending, or deleting requires approval. |
| Pages.tsx:637 | Your apps (Notes, Calendar, Mail…) it may use like a person, without moving your mouse. For each, read only or also change things; a click that sends, pays, publishes or deletes asks for your approval. | Set read or write access per app. Agents work without moving your mouse; sending, paying, publishing, and deleting require approval. |
| Pages.tsx:1033 | Lend a folder… | Share a folder… |
| Pages.tsx:1056 | Give back | Remove access |
| Pages.tsx:1037 | Lend it a project folder to work in. It changes the real files, so use git to be able to undo. | Share a project folder. Changes affect real files; use Git to keep them reversible. |
| Pages.tsx:1061 | Lending or giving back restarts the computer: services stop, what it installed stays. With no credentials inside, publishing the code and putting it live stay with you. | Changing shared folders restarts the computer and stops services; installed software stays. Without credentials, you must publish and deploy. |
| Pages.tsx:1475 | The services your agents work with. You sign in through the browser and the access stays on this computer (except for those that go through a third party, like Composio); every call the agents make goes through permissions and approvals. | Connect services through your browser. Access stays local except with third-party providers such as Composio. Permission and approval rules apply to every call. |

## Notification recovery pass

The measured blocked-notification hint took four lines at 900 px. Keep recovery first and shorten the alternatives. Desktop/iPhone setup remains available from navigation.

| Current English | Proposed English |
| --- | --- |
| To be told, use the Tucano app on your computer (Settings › Servers), the iPhone app or Telegram (Settings › Phone). | Alternatives: desktop, iPhone, or Telegram (Settings › Phone). |
| Browsers don't show notifications from an address without HTTPS (like Tailscale's, http://100.…).  | Browser notifications require HTTPS.  |
| The browser blocked notifications from this address. Allow them in the site’s permissions and reload the page.  | Allow notifications in site settings and reload.  |
| Notifications can't be shown here.  | Notifications are unavailable here.  |
| Sent one. If it didn’t show, check System Settings › Notifications › Tucano (allowed, with Banners or Alerts) and whether a Focus is on. | Test sent. If missing, allow Tucano banners or alerts in System Settings › Notifications, and check Focus. |
| Sent one. If it didn’t show, check the system’s and the browser’s notification settings for Tucano, and Do Not Disturb. | Test sent. If missing, check Tucano’s system/browser notification settings and Do Not Disturb. |

## Update status copy

The off state must describe its actual state rather than imply that installation enables updates.

| Current | Proposed |
| --- | --- |
| 'Updates work in the installed app.' | 'Automatic updates are off.' |
| 'Couldn’t look for a new version just now. Try again later.' | 'Could not check for updates. Try again later.' |
| `Tucano ${u.next} is ready. It goes in when you restart or quit the app.` | `Tucano ${u.next} is ready. Restart or quit to install.` |
