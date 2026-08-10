---
name: Group event view-vs-book split
description: Group events are viewable by everyone but bookable only by active group members; where the gates live and the memberEmail authz pitfall.
---

Group events (event/complex_event with `member_group_id`) are **viewable by anyone with a direct link** (public detail endpoints return them, incl. `member_group_name` for UI copy) but **bookable only by ACTIVE members of the linked group** (unexpired `member_group_assignment` + `member_group.is_active !== false`, shared helper `isActiveMemberOfGroup` in `api/_lib/ticketAccess.js`). List endpoints still hide private group events.

**Why:** members share event links outside the group; the join-the-group funnel (JoinGroupToBookCard → group page, or login with `returnTo` + `groupId` follow-through) replaces the booking pane for non-members.

**How to apply:**
- Any new booking path for group events must call the active-membership guard server-side.
- CRITICAL pitfall: `createOneOffEventBooking` resolves `member` from the client-supplied `memberEmail` — that is NOT authentication. Authorization decisions there must verify `getSessionMember(req).id === member.id` first (same pattern as the member-targeted discount check).
- Client gate should use the `/api/member-group-events/my-groups` endpoint (`useMyGroupIds`) — it applies the canonical active-member definition; the raw `member_group_assignment` client queries do NOT filter expiry/inactive groups and are kept in sync with the server's ticket-access matching, so don't "fix" them.
