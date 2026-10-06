---
name: Group event view-vs-book split
description: Public group events allow guest self-registration; group-only events retain active-membership authorization.
---

Public group events allow guests and signed-in non-group members to register for independently eligible tickets. Only an explicit stored true public flag grants this exception. Group-only events retain active-membership authorization. All group events remain self-registration-only.

**Why:** The user explicitly replaced the historical universal group booking gate with the editor's public-audience promise. Registration must not join the group or confer membership access.

**How to apply:**
- New booking paths must separate group ownership/self-only limits from group-only audience authorization. Do not change listing, direct-link visibility, or ticket restrictions as part of that distinction.
- CRITICAL pitfall: `createOneOffEventBooking` resolves `member` from the client-supplied `memberEmail` — that is NOT authentication. Authorization decisions there must verify `getSessionMember(req).id === member.id` first (same pattern as the member-targeted discount check).
- Public audience waives group membership, never authentication for a claimed member identity or independent ticket visibility. Genuine guest registration must stay guest-classified for authorization.
- Client gate should use the `/api/member-group-events/my-groups` endpoint (`useMyGroupIds`) — it applies the canonical active-member definition; the raw `member_group_assignment` client queries do NOT filter expiry/inactive groups and are kept in sync with the server's ticket-access matching, so don't "fix" them.
