# Conversations, channels and threads
> Channels, direct messages, threads, mentions, who answers, passing the turn between agents, stop and try again, images and dictation.

## Channels and DMs
- **Channel**: the **+** beside **Channels**, ⌘N (Ctrl+N), or **New channel** in ⌘K. A lowercase name with hyphens ("Squad Payments" becomes squad-payments), then the agents.
- **DM**: the conversation with one agent alone. It always answers there. In the agent's menu, **Send a message**.
- In the channel's menu (right-click it in the sidebar): **Add or remove agents…**, **Channel settings…** (name, **Topic** and where the agents answer), **Mark as read**, move and group, **Delete channel…**.

## Who answers in a channel
- With @handle, whoever was called answers.
- With no mention, the **Router** reads the conversation and picks who answers, by each one's role and connectors.
- When an agent mentions another in its reply, the router reads it first and only calls whoever has something to do: a "thank you" wakes nobody. If the one called is already answering there, it does not open a second reply: it sees it next time.
- After 3 replies in a row between agents starting from one of your messages, the conversation between them stops. Send a message to carry on.

## Threads
In **Channel settings…** (or **Conversation settings…** in a DM), **Where the agents answer**:
- **In the conversation, like a chat**: the replies come right below.
- **In threads, one per message**: each message opens a thread beside it.

Either way you can open a thread on a message with **Reply in thread**. An agent in a thread reads only that thread.

## During the reply
- The steps appear while the agent works. **Stop** interrupts.
- **Retry** on a reply that failed or was interrupted.
- It reached the reply's ceiling: it pauses and asks. **Continue** goes on from where it stopped.
- A question from the agent: your next message there is the answer.
- **See receipt**: tokens, cache, time and the equivalent on the API.

## Summary
The **Summary** button at the top shows what the conversation has covered. The last 30 messages go in whole; past 50, what leaves the window becomes a summary. You can **Summarize now** and edit it.

## Attachments and dictation
- Up to 10 images and 5 files per message (clip, drag or paste). From a PDF, Word, spreadsheet and text, the agent gets what is written, even with no computer; later it re-reads it with ler_anexo.
- Dictation: the microphone in the field, or ⌥ Space on the Mac and Ctrl+Space elsewhere. The audio becomes text on the computer itself, with no internet. Turn it on in **Settings › General** › **Dictation**.

## When it goes wrong
- "Interrupted: the app closed in the middle of the reply": **Retry**.
- Nobody answers and the paused note appears: the agents are paused (the button at the top of the sidebar).
