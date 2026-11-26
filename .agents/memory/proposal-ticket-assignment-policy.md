---
name: Proposal ticket assignment policy
description: Owner-approved event eligibility, closure, return access and operational boundaries for Sales tickets.
---

New tickets belong directly in bundles or proposal lines, not in newly created
products. Preserve existing ticket products and their historical links.

**Why:** The user approved retiring the competing ticket-product creation path
to simplify authoring without changing existing sales evidence.

**How to apply:** Product copies must not create new ticket-linked products;
complimentary membership remains a product benefit.

New proposal ticket selections require a known future start instant. Draft events
are selectable by authorised Sales staff; past, undated and waiting-list-mode
events are not. Purchased draft entitlements do not authorise public discovery.

Unchanged existing bundle ticket components must remain editable for unrelated
proposal billing changes after their events start.

**Why:** Proposals may be entered or amended partway through delivery and billing;
reapplying new-selection eligibility prevents recording instalment commitments.

**How to apply:** Use server-loaded prior line/component identity and unchanged
quantities to preserve the existing reference. New or changed selections still
require eligible events, and tenant/ticket ownership checks remain mandatory.

**Why:** These are the explicit planning defaults for the purchaser-managed
proposal ticket journey, not assumptions derived from general event discovery.

Ticket auto-close is optional and adds to existing event registration restrictions.
Show the earliest applicable deadline, with no invented ticket countdown when
there is no ticket deadline. Purchased but unnamed places are not automatically
released, forfeited or refunded at closure. Return access must support secure
renewal/reissue where token lifetime would otherwise prevent it.

**Why:** Closure limits registration and amendment; it is not cancellation or
financial authority.

**How to apply:** Reuse the commercial allocation, booking and fulfilment systems.
Purchaser amendments must not overwrite generic member profiles or leave obsolete
QR credentials usable. Ticket-bearing form-cart bundles are explicitly unsupported
and must be rejected, not charged without ticket fulfilment. Live migrations,
historical backfills and real provider/email actions require separate approval.

Purchaser management does not override member-group events' existing attendee
self-registration rules; preserve their invitation route rather than weakening
membership checks.

**Why:** A paid allocation grants places, not permission to bypass an event's
participant-identity policy.

Legacy remaining-seat counters must be consumed in the same transaction as an
allocation claim, unless the enclosing booking batch already owns that counter.
Never reconstruct an original capacity maximum from a remaining counter.

**Why:** Separate claim/counter requests temporarily expose reserved places to
other purchases; decrementing again inside an already transactional credit batch
would consume the place twice.

Proposal Event ticket lines take description, standard unit price (net of the
ticket's VAT-inclusive current price, early bird if active) and VAT from the
ticket on the server; the browser only sends reference, quantity, discount and a
permission-gated quoted override. Product lines inherit the catalogue product's
ticket link only; a different submitted link is rejected unless it is the
unchanged saved reference.

**Why:** Approved simplification so line types do not overlap and prices cannot
drift from the ticket.

**How to apply:** Unchanged saved ticket lines keep their recorded terms; a
different provider VAT code is accepted only when the ticket's VAT has no synced
provider code, never to replace a mapped ticket VAT.
