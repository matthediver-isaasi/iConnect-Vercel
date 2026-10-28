# Zoom registration booking recovery — read-only evidence

Verified on 2026-10-28 for event `4a21aa95-0c72-4317-a8eb-638ec73c96b0`.

- Destination REST host was pinned to the documented current Supabase project,
  `lvmzliemqnieeoruhkik.supabase.co`, before querying.
- Workspace runtime target matched SOURCE, not DEST. Verification explicitly
  selected DEST before dynamically importing the application's database/helper.
  Workspace environment settings were not changed.
- The event exists in DEST and has a linked meeting (not a webinar).
- Exact original tenant/event/confirmed-status scoped, ordered first-page query
  failed with SQLSTATE `42703`: `column booking.discount_amount does not exist`.
- An independent scoped projection of `free_tickets` also failed with `42703`.
- Neither field is consumed by registration or confirmation delivery.
- The corrected projection includes confirmation reference, ticket price/class,
  total cost and member identity fields. The actual application helper returned
  70 bookings; every row matched the event, tenant and confirmed status.
- No attendee data, credentials or join URLs were printed or retained.
- No database writes, Zoom calls, reconciliation, cancellations or emails occurred.

This proves the database query repair, not live provider reconciliation or a
production rollout. Node tests cover the actual helper with multi-page fixtures,
later-page failure and endpoint safety. Playwright exercises the actual dialog
with intercepted API responses for live/cached partial evidence and blocked
actions. The signed-in production editor was not browser-verified.
