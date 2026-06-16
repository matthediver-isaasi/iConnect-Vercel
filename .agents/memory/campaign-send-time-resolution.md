---
name: Campaign per-recipient resolution & tracked-link entities
description: Why campaign personalization (booking, QR, scope) must resolve at SEND time, and how tracked-link hrefs corrupt query strings via &amp;.
---

## Campaign recipients are persisted, so per-recipient context must resolve at send time
Email-campaign recipients are written to the `email_campaign_recipient` table (campaign_id, member_id, email, first_name, last_name, status) and re-claimed in batches at send time. Anything you compute while *building* the audience (e.g. which booking row a recipient owns) is NOT carried on the in-memory recipient array — it does not survive the DB round-trip.

**Why:** the send path reads recipients back from the table, so extra fields attached during audience-building are lost.

**How to apply:** resolve per-recipient personalization (booking row, QR image, event scope) at SEND time inside `sendToRecipient` (campaignService.js), mirroring `resolveEventQrImageUrl` / `resolveCampaignEventScope`. Don't try to thread context through the recipient array.

## Booking tokens in campaigns must match the attendee's OWN row, not the group
`[[booking.id]]` must resolve to the recipient's attendee-level `booking` (or `complex_event_booking`) row id, matched by `attendee_email` ilike, scoped to the campaign's event(s). Fall back to the booker `member_id` only for legacy rows with empty `attendee_email`. `complex_event_booking` has `total_paid` (no `total_cost`). The shared token map lives in `replaceBookingPlaceholders` (exported from `eventConfirmationEmail.js`) — reuse it, don't duplicate.

## Tracked links corrupt query strings: decode &amp; before wrapping
The rich-text editor stores a typed `&` in an href as the entity `&amp;`. `rewriteLinksForTracking` percent-encodes the captured href verbatim into `/api/track/click?...&url=<encoded>`; the click handler `decodeURIComponent`s once and 302-redirects, so the literal `&amp;` survives and the browser parses `&amp;booking_id=` as a param named `amp;booking_id`.

**Why:** one decode layer (the click redirect) can't undo an HTML entity — that's a separate decode.

**How to apply:** decode HTML entities (`&amp;`, numeric `&#38;`/`&#x26;`, etc.) on the href *before* `encodeURIComponent` in `rewriteLinksForTracking`. Booking/token substitution must also run BEFORE `rewriteLinksForTracking` so resolved ids land inside the tracked URL.
