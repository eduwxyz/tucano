# Room visibility and agent read access

This implements the design in issue #423. The feature is in progress; the shared permission
contract is the first step, not an enabled interface or completed access-control implementation.

Room visibility and agent read access are independent. A room can remain private while its
creator lets a selected agent retrieve context from it. That agent may retrieve the context
only while helping someone who can see the source room. The agent cannot carry that permission
into another person's private conversation.

New user-created rooms default to private. Existing shared rooms preserve their audience.
DMs remain private and cannot be shared through channel settings. A team-up derived from a
private conversation must preserve its audience, including existing history and attachments.

Agent read access has three choices: members only, selected agents, and all workspace agents.
Membership continues to grant read access. Additional read permission grants retrieval only;
it does not join the agent, allow it to speak or edit, or deliver every message automatically.

Tuca can propose creation settings and changes to an existing room while discussing its
purpose. The proposal must name the room, its audience and agent read policy. The person
applies the proposal. Widening visibility requires a clear confirmation that existing history
and files will become visible to the workspace. Tuca must not silently apply that change.

## Enforcement map before enabling private rooms

The current product treats channels as shared. Adding a private flag requires changing the
paths that rely on that assumption together; filtering the sidebar is insufficient.

| Path | Required boundary |
| --- | --- |
| `Db.conversationOwner`, `People.canSeeConversation` | Carry the channel's creator and visibility through the lightweight checks used by RPC and events. |
| Snapshots, paging, search and direct IDs | Check the current audience, then apply existing message-level history restrictions. An agent's retrieval grant cannot bypass either check. |
| Unread counts, notifications and push | Select recipients from the room's current audience; do not broadcast private activity to all workspace people. |
| Memory and wiki consolidation | Preserve private-room provenance in learned notes, page holds and summaries. Recheck it before publishing pending model output. |
| Activity, exports, artifacts and links | Apply the source room's visibility to derived records and files, including direct-ID requests. |
| Approvals | Preserve the existing approval-decider contract without granting access to the surrounding private transcript. Explain any required disclosure when the action is proposed. |
| Revocation | Remove cached messages, thread pages, summaries, unread counts and artifacts from connected clients. Discard responses from reads started before revocation. |
| Tuca proposals | Validate the room creator's authority at application time. Applying a group of proposals must not bypass the confirmation for sharing existing history. |

The team-up audience rules in #274 must survive integration. A private source remains
private when work moves to a team-up; a missing source must not become evidence that it
was shared. Explicitly sharing an inherited room requires the same history confirmation.

The per-bot initiative proposed in #435 must use the same requesting-person boundary for
observation and work scopes. A saved scope is not permanent authorization: each check-in,
retrieval, retry and resumed session must respect revocation and avoid carrying old private
context into a newly shared destination.

Keep user-facing creation paths unchanged until these checks are implemented together.
Persisting a field or passing the shared policy tests alone must not enable private defaults.

## Planned interface copy

| Surface | Exact English |
| --- | --- |
| Human audience label | Visibility |
| Private choice | Private |
| Workspace choice | Shared with workspace |
| Agent permission label | Agent read access |
| Read choices | Members only / Selected agents / All agents |
| Read scope hint | Agents can read only rooms visible to the person they are helping. |
| Read effect hint | Read access does not let an agent join or reply. |
| Sharing confirmation title | Share #name with the workspace? |
| Sharing warning | Everyone in this workspace can read this room's history and files. |
| Confirm action | Share room |
| Cancel action | Keep private |

The confirmation warning must remain fully visible. Its privacy consequence takes precedence
over the two-line hint guideline. Measure the actual controls at 900 and 1280 CSS pixels,
plus any supported smaller layout, and verify the installed Electron renderer's scaling.

## Implementation and validation

- [x] Define visibility and read-permission fields and their shared permission rules.
- [x] Add tests for private ownership, legacy sharing, immutable DM privacy, selected readers,
  archived agents and the requesting person's visibility boundary.
- [ ] Persist and validate settings through the core RPC contract.
- [ ] Default every user-facing creation path to private; preserve existing shared rooms.
- [ ] Enforce visibility on snapshots, events, direct reads, artifacts, links and notification feeds.
- [ ] Invalidate existing client caches when access is revoked.
- [ ] Grant read-only cross-room retrieval without membership, speaking or editing rights.
- [ ] Recheck current permissions at each retrieval during long-running work.
- [ ] Add room controls and Tuca proposals, including sharing confirmation.
- [ ] Test private team-up inheritance, purge/export behavior and restart persistence.
- [ ] Complete keyboard, rendered copy, screenshots and installed-runtime checks.
- [ ] Pass typecheck, the full suite and the isolated built-app flow.
