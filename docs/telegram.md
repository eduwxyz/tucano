# Telegram tasks and finished replies

Pair your bot in **Settings → Phone and GitHub**. Only the paired Telegram chat
can send tasks, answer questions or act on approvals.

- Enable **Send messages to agents** to send new tasks from Telegram. It is
  **off by default** and independent of finished-reply notifications. When it
  is off, replies to known agent messages and approval buttons still work;
  new tasks are not posted or sent to AI triage.
- Send a new message such as “on company X, check the dates of the next 3
  meetings”. Before posting anything, the configured router model sees the
  message and the available channels, topics and agents (including their roles
  and connector access). It chooses one channel and one agent. It gets no tools
  and does not execute the task itself.
- With one channel, delivery goes straight there; AI still selects an agent if
  it has multiple active members. With one channel and one agent, no AI triage
  call is needed.
- If the channel cannot be identified or triage fails, the fallback is
  `#general`/`#geral`, or the first channel when neither exists. The channel's
  first active member is the fallback speaker if AI cannot select one. Empty
  channels cannot run tasks; the bot reports that delivery failed.
- **Receive all finished replies** is **off by default**. Enabling it mirrors
  completed agent replies from channels and DMs, even when started in the app.
  This shares those responses with Telegram. Long replies arrive in multiple
  parts rather than being truncated. It does not forward streaming drafts,
  stopped/failed runs, or re-send answered questions as completed tasks.
- Approvals, high-risk confirmation, agent questions and existing routine
  notices are independent of both switches and continue as before.
- Reply to a question, completed response, or delivery acknowledgement to stay
  with its channel and agent instead of running new-message triage. Replies to
  completed responses also give the agent the original message as quoted
  context. Unknown/expired reply mappings are rejected, never silently routed
  elsewhere.

Reply mappings live in encrypted secret storage alongside the bot pairing,
survive app restarts, and retain the latest 2,000 outgoing message IDs. Unpairing
or replacing the token clears them. As before, the app must remain running and
online to poll Telegram and execute work. Triage usage is recorded as router
usage; when TypeSafe/Jev is selected, Telegram triage uses the existing Haiku
fallback because Jev's channel speaker protocol cannot choose channels.

## Workspace integration boundary

This branch starts from upstream `main`; it does **not** merge workspace PR
[#63](https://github.com/eduwxyz/tucano/pull/63). It routes within the current
single/default workspace. `PhoneChannel` and `PhoneTarget` in
`src/core/telegram-router.ts` carry explicit `workspaceId` values, and selection
validates the workspace/channel pair before considering its agent. Persisted
reply destinations carry that scope too.

When integrating #63, keep one polling bot in the default workspace, collect
rosters through the workspace coordinator and dispatch validated destinations
to their owning core. Forward scoped completion/question events back to that
bot. Do not start competing pollers or read sibling databases directly.
The current dispatcher deliberately rejects non-default workspace IDs rather
than accidentally posting a cross-workspace reply into the default workspace.

## Checks

```sh
npm run typecheck
npm test
npm run build
node scripts/telegram-e2e.mjs
```

The last check launches the real Electron UI and utility-process core with
isolated data. Telegram's API and the AI engine are deterministic stand-ins;
no real Telegram credentials or live model are used. Instrumentation affects
only a disposable copy of the compiled app under `/tmp/opencode`, not production
source or build output. It checks routing, the default-off shared switch,
persistence/replies across restart, existing questions, approval buttons and
Telegram decisions, fallback and sole-channel delivery. Approval
authorization/high-risk behavior is also covered by the Telegram unit tests.
