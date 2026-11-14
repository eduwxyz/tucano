# When something goes wrong
> Diagnosing the common problems: an agent that doesn't answer, a harness without a sign-in, a connector asking for sign-in or failing, Docker off, limits, a routine that didn't run, an expired approval, a notification that doesn't arrive.

## The agent does not answer
1. Are the agents paused? The sidebar's top button shows ▶ (**Resume agents in this workspace**) and the conversation shows the paused note. Click to resume.
2. Is its harness ready? **Settings › Models**: **Not signed in** needs **Sign in**; **Not installed** needs **Install**. An extra account not signed in leaves the agent not answering.
3. Did it hit the month's limit? **Usage and limits** says "Hit the limit". Raise the limit on its page.
4. In a channel, nobody was picked? Call it with @handle, or check that it is in the channel and its **Role** says what it does.
5. Archived? Archived agents do not answer: **Archived** › **Reactivate**.

## The reply failed or stopped
- The failed step shows the reason; **Retry** repeats it.
- "Interrupted: the app closed mid-reply": **Retry**.
- Paused at the reply's ceiling: **Continue**, or raise the **Limit per reply**.
- Cut by a loop or a stall: rephrase the request in smaller parts.
- The subscription ran out (Claude, ChatGPT…): wait for the window to reset (**Usage and limits** shows when) or give the agent a **Reserve model**.

## Connector
- **Needs authorization**: **Authorize in the browser** on the connector's page.
- **Did not connect**: **Connect again**; if it continues, check the address and the login (a new token in **Token (replaces the current one)**).
- The agent does not see the tool: check its level for the connector (**Read** shows only the reading ones), the tool on the connector's page, and **Refresh tools**.
- It only fails on one network (company, proxy, antivirus): the message says why; see **rede**.

## The agent's computer
- **no Docker**: open Docker Desktop and **Check again**.
- **it did not start**: **Restart**; if it continues, **Erase computer**.
- A service stopped: ask the agent to bring it up again.

## A routine that did not run
- The app was closed over 12 h after the time, it was in **Quiet hours**, or the agents were paused.
- The agent was archived (its routines turn off), or the routine is off.
- A connector routine only fires on a new item; **Test now** shows what it sees.
- Waiting for an approval: decide in **Approvals**.

## Approval
- Expired: nothing happened. Ask the agent again. The deadline is in **Settings › Agents** › **Limits** › **Approvals expire after**.
- You approved and saw nothing: it arrives in a new message from the agent.

## A notification that does not arrive
- **Settings › General › Notifications** › **Send one**. On the Mac, Tucano only appears in System Settings › Notifications after the first.
- On the Mac: System Settings › Notifications › Tucano allowed, and no Focus mode on.
- A conversation open on screen does not notify.
- Server: it notifies through the desktop app connected to it, in **Settings › Servers**. The browser only notifies over HTTPS. See **servidor**.

## Microphone (dictation)
- "The microphone is blocked": allow Tucano in the system's privacy settings (Mac: System Settings › Privacy & Security › Microphone).
- "No sound from the microphone": check which one the system's sound settings use.

## Computer apps
"Accessibility permission is missing": allow Tucano in Settings › Privacy & Security › Accessibility (on the Mac).
