# Memory
> What the agents know about you: how they learn, approve or leave it automatic, each agent's notes and the summary of long conversations.

## Two kinds
- **You**: preferences, patterns and facts that hold for every agent. They go into the prompt of every reply.
- An agent's **work notes**: only it sees them.

The **Context** in **Settings › General** is another thing: a fixed text you write that every agent always reads.

## How they get in
1. You teach: in **Memory**, in **Teach something about you**, write and Enter keeps it.
2. An agent keeps one during the conversation, following its mode (**Memory** tab on the agent's page): **Saved on its own** (it saves and says so in the message, with **Undo**), **Asks for approval** (it waits for you to keep it) or **Read only** (it uses memories but saves no new ones).
3. The memory model learns from the conversations. In **Settings › Models** › **Memory**, **What it learns about you**: **Becomes a suggestion for you to approve**, **Saves on its own** or **Nothing (just summarizes)**. Only what you said counts, never what an agent assumed.

## The Memory screen
- **New**: the suggestions waiting for you to **Keep** or **Discard**.
- **Still true?**: memories unconfirmed for a long time. They stay in the prompt until you decide (**Still true** or **Forget**).
- Each memory can be edited or forgotten. **Forgotten** ones leave the prompt, and the record stops them being learned again; **Delete for good** removes even that.
- Older memories can fall outside the prompt; the agents find them with a search when they need to.

## Summaries of conversations
The memory model also sums up what leaves the window of long conversations (it runs every ~20 messages in a long conversation) and, from a thread left alone for a few minutes, takes a summary of its own. See the **Summary** button in each conversation (page **conversas**).

## When it goes wrong
- The agent "forgot" something: check that it is in **Memory** and not in **Forgotten**; teach it again with a short sentence.
- It kept something wrong: edit it, or **Forget** it on the Memory screen.
