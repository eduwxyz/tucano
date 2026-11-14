# Routines
> An agent working on its own: at a time, when something new appears in a connector, or when called on this computer.

A routine is a request the app sends an agent by itself, in a DM or a channel it is in. The reply appears in the conversation, marked as one.

## Creating one
1. In **Routines** (a week's calendar), click a time or **New routine** (N).
2. **Name**, **Agent** and **What to do**: write it as a message. It uses the tools, connectors and computer it has.
3. **When it runs**:
   - **At a time**: how it repeats, the days and **At**, on your computer's clock. **+ time** puts more than one in a day (9am, 1pm and 5pm), in **Every week** and **Monthly**; the × takes it out.
     - **Every week**: on the chosen **Days** (Mon to Fri, every day or picked ones).
     - **Once**: on the next marked day whose time has not passed yet; after running, it turns itself off.
     - **On a date**: on a calendar day (e.g. 17/11 at 9am), even months ahead. It runs once and turns off.
     - **Monthly**: on a day of the month (e.g. every 5th). In a month without it (the 31st in November), it runs on the last one.
   - **When something new appears**: pick a **Connector**, a **Read tool**, the **Arguments (JSON)** (the search's filter) and how often (**Check every**). What exists now does not fire: once per new item, one at a time. **Test now** shows what it sees.
   - **When called on this computer**: after saving, the routine gets an address only this computer reaches. A script or git hook calls it with `curl -d "what happened" <address>` and the text reaches the agent. One call at a time: if it is still running, the next is refused.
4. **Where to post** and **Create routine**.

The agents also schedule things themselves when you ask for something later ("in 10 minutes", "every day at 9am and at 3pm", "the 17th at 9am", "every 5th"). It shows **Scheduled:** with **Undo**.

## In the calendar
Click a routine to see **Ran** / **Will run**, **Run now**, **See the reply**, **Edit** and **Delete**. The ← → arrows change the week, T goes back to this one. **Show only one agent's** filters.

## When it runs, and when not
- Routines run while the app is open, window closed included, so you need not open it: turn on **Open when the computer starts** in **Settings › Agents** › **Routines** (installed app only).
- App closed at the time: it runs when it opens, up to 12 h later, marked late.
- **Quiet hours** (same place): routines and triggers wait and run when it is over; what you send is still answered.
- Agents paused (button at the sidebar's top): no routine runs; a call through the address answers that they are paused.
- A reply that fails is tried again after 1 and after 5 minutes.
- If the previous one is still running, the new turn is skipped.
- Each agent has a maximum of routines on (**Max routines on**, 10 by default).

## When it goes wrong
- It did not run: the app was closed for over 12 h, it was in quiet hours, the agents were paused, or the agent was archived, which turns them off.
- "The connector could not be read": the connector is disconnected or asks for a login (see **conectores**).
- It sat waiting for an approval: decide in **Approvals** or through Telegram.
