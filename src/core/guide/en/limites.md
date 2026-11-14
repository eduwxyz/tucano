# Limits, usage and pause
> Each agent's monthly limit, the ceiling per reply, when a reply is cut, Usage and limits, Report, pausing everything and quiet hours.

## The month's limit
Each agent has a **Monthly limit (millions of tokens)** on its page (**Profile** tab). The default for new agents is in **Settings › Agents** › **Limits** › **Default limit per agent** (2 million by default). The limit is checked before every reply. Reading from cache counts 10%. Once it is hit, the agent stops until the month turns or you raise the limit; the reply shows **Raise …'s limit**.

## The ceiling per reply
**Limit per reply (% of the monthly limit)**, 10% by default. When it reaches it, the agent pauses and asks whether to go on: **Continue** goes on from where it stopped.

## Replies that are cut
- **Treat as stuck after (min with no sign)**, 20 min by default: with no text and no tool finishing in that time, the reply is cut. Long work that is moving is not cut.
- An agent that repeats the same thing, with the same result, several times is stopped ("It looked like a loop").

## Usage and limits
The **Usage and limits** screen shows what each agent spent in the month and where it will end at the current pace, the usage per model, the **Behind the scenes** (what the app itself spends: the router, memory and the Tuca) and the **Recent receipts**. With Claude on a subscription it also shows the plan's **5-hour window** and **Week**. **Worth on the API** is what it would cost paying the API; on a subscription it is not charged.

## Report
The **Report** shows the week: how many replies ended well, per agent and per task, and what failed, was cut or refused, with a link to the reply. The ← → arrows change the week.

## Pausing everything
The pause button at the top of the sidebar pauses the workspace: no agent starts working and no routine runs. Whatever is already running finishes. A message of yours gets the note that the agents are paused. The same button resumes.

## Quiet hours
In **Settings › Agents** › **Routines** › **Quiet hours**: routines and triggers wait and run when it is over. What you send is still answered.

## When it goes wrong
- "Stopped at the limit": raise the agent's limit, or wait for the month to turn.
- The Claude or ChatGPT subscription ended: the agent stops; a **Reserve model** on another account or another harness takes over (see **motores**).
