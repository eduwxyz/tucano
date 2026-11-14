# Agents
> Creating an agent, instructions, model, limits, tools and access, memory, appearance and archiving.

## Creating one
- With the Tuca: the **+** beside **Agents** in the sidebar opens the Tuca. Describe the task, and it proposes an agent in a card: **Create**, **Edit first** or **Discard**.
- By hand: **New agent (form)** in ⌘K (Ctrl+K). Fill it in and **Create agent**.

## The agent's page
Click the agent in the sidebar (or **See profile** in the conversation). It has four tabs:

**Profile**
- **Identity**: **Name**, @handle (2 to 32 lowercase letters, numbers, - or _), **Role** (one line that helps decide who answers in a channel), **Color** and **Appearance** (default face, another color or an image).
- **Instructions**: write it as you would for a new colleague: what to do, what to avoid, when to ask. The workspace **Context** already goes into every conversation; here goes only what belongs to this agent.
- **Where it runs and model**: harness, model, **Reasoning effort** (more effort thinks more and spends more), **Reserve model** and **Account**.
- **Monthly limit (millions of tokens)**: checked before every turn. **Max routines on**: how many routines it may have on at the same time (10 by default).

**Channels and skills**: **Where it takes part** and the skills it follows. Outside those channels it answers when called with @handle.

**Tools** — changes on the spot, nothing to save:
- **Tools and access**: one level per connector, **No access**, **Read** or **Read and write**. Whatever is left out does not even reach the model. Sensitive tools become an approval request (see **aprovacoes**).
- **Web**: searches and reads pages with Claude Code's or Codex's own tool.
- **Browser**: a Chrome of its own, with logins kept apart from yours (you sign in through **Take over**).
- **Computer**: **None**, **Isolated Linux** (Docker) or **This computer**, plus the lent folders (see **computadores**).
- **Computer apps**: Notes, Calendar, Mail… which it drives like a person, with **Read only** or **Read and change**. On a Mac it needs the Accessibility permission.

**Memory**: how it keeps memories about you — **Saved on its own**, **Asks for approval** or **Read only** (it uses memories but saves no new ones) — and its wiki access (**Reads the wiki** or **No access**). Its working notes are its own.

## Archiving
In the agent's menu in the sidebar (right-click), **Archive…**. It leaves the sidebar, stops answering and its routines turn off. History and receipts stay. To bring it back: **Archived**, at the end of the agent list, **Reactivate** (turn its routines back on in Routines).

## When it goes wrong
- It does not answer: check that its harness is **Ready** in Settings › Models, and that it has not hit the month's limit (**Usage and limits**).
- In a channel it is never picked: check that it is in the channel (**Add or remove agents…**) and that its **Role** says what it does; or call it with @.
