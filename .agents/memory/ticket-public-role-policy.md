---
name: Public and member-role ticket audiences
description: Public visibility does not require an anonymous visitor to satisfy member role restrictions.
---

For Members & Public tickets, public visitors qualify through the public
audience. Authenticated members must still satisfy the ticket's configured
role-or-member-group restrictions. Missing member roles must not downgrade an
authenticated purchaser into the public audience.

**Why:** On 2026-11-27 the owner explicitly required public visitors to see
Members & Public tickets while authenticated members see only tickets allowed
by their assigned audience.

**How to apply:** Keep discovery, event-page selectors, funnel offers and
server-side purchase eligibility consistent. Determine purchaser identity from
the verified session, never a submitted guest flag or attendee details. Preserve
members-only/public-only visibility, selected-member privacy, independent
Organisation Type requirements, release/close windows and purchased-allocation
exceptions. Public visibility does not bypass those independent requirements.
