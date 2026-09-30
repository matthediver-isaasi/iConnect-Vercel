---
name: Transactional inbox delivery
description: How transactional emails land in a member's /inbox alongside campaign messages, and the two-backend union every inbox endpoint must respect.
---

The member `/inbox` now unions TWO different backends, distinguished by a
`source` field on each message:

- **Campaign messages** (`source: 'group'` / `'admin'`): per-member read/pin/
  archive/favourite state lives in a SEPARATE sparse state table (no row =
  unread) keyed by the campaign recipient row. See memory
  `member-inbox-unread-count`.
- **Transactional messages** (`source: 'transactional'`): each row of
  `member_transactional_message` is inherently per-member, so state
  (is_read/is_pinned/is_archived/is_favourite/folder_id/read_at) is
  CO-LOCATED on the row itself. No parallel state table.

**Why:** a transactional email is always addressed to exactly one member, so a
separate state table would be redundant; campaigns fan out to many members so
they need one.

**How to apply:** ANY inbox surface must handle both sources or one kind of
message silently disappears. The endpoints (`api/communication/inbox/`) fetch
both, tag each with `source`, and merge sorted by `sent_at`. Mutations (POST,
`[id].js` detail via `?source=transactional`) branch on source to hit the right
table and verify ownership per-table. On the client, `useInbox` act/actBulk/
fetchInboxMessageBody are source-aware, and `Inbox.jsx` keeps a `msgById` map to
resolve each id's source (bulk selections are split by source before dispatch).

Every message now carries a resolved human-readable `label`
(`resolveTransactionalInboxLabel` in `api/_lib/transactionalInbox.js`: prefers a
Communication Category name, else a built-in key label, else "Notifications").

**Delivery gate:** `sendEmail()` only records to the inbox when the caller passes
an `inboxDelivery` descriptor. Auth/system emails omit it and are therefore
never delivered to any inbox. Recording never throws and never affects the send
return contract. Wiring which specific email families opt in is downstream work.
