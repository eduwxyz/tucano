# Approvals
> What waits for your ok, how to decide, always allow, high-risk actions and expiry.

Nothing sensitive happens without you. When an agent wants to publish code, put something online, delete something or send something out, the action does not run on the spot: it becomes an approval request, with the tool and the exact arguments.

## What asks for approval
- Connector tools of the **sensitive** class. By default: deleting, sending, publishing, putting something online, paying, and passing anything to other people (posting, replying, forwarding, commenting, sharing, inviting). A draft does not ask.
- Opening a PR on GitHub.
- In the agent's browser and in computer apps, clicks that buy, publish, send, pay or delete.
- Requests for access: an agent with no access (or only reading) to a connector may ask; if you grant it, it carries on in a new message.

## Where to decide
- In the conversation itself, on the request's card.
- In **Approvals**, in the sidebar, which lists everything waiting for you and the **History** (approved, refused, expired). **See in the conversation** takes you there.
- On your phone, through Telegram (see **celular**).

## The buttons
- **Approve**: covers this call only, with these values. If the agent changes anything, it asks again.
- **Refuse**: you may say why; the agent gets the reason.
- **Approve and always allow**: from now on that agent uses that tool without asking. It does not apply to high-risk actions. In Composio it applies to each action in the request (GMAIL_REPLY_TO_THREAD, for instance), not to the whole executor (see **composio**). To undo it, on the agent's page, **Tools** › **Always allowed, without asking:** › **Ask for approval again**.
- A **high-risk** action: you have to hold the button to approve (**Hold to approve**). On Telegram it is two taps.

Would you rather a connector posted without asking anyone? On its page, change the tool's **Class** to **write**. What you choose by hand stays, even when Tucano's own rules change.

## Expiry
A request with no decision expires. The deadline is in **Settings › Agents** › **Limits** › **Approvals expire after**: 1 hour, 24 hours (the default) or 7 days. Expired, nothing happens; ask the agent again if you still want it.

## When it goes wrong
- I approved and nothing happened: the result arrives in a new message from the agent. Look at the conversation.
- A routine at night sat waiting: turn on Telegram so you can decide from anywhere.
