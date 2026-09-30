---
name: Member inbox unread count without row enumeration
description: How the inbox derives delivered/unread counts from campaign recipients + a sparse state table, and why the badge count uses arithmetic instead of scanning rows.
---

# Member inbox model

The member-facing inbox has NO messages table of its own. "Messages" are
`email_campaign_recipient` rows (delivered when `sent_at` is not null) joined to
`email_campaign`. Read/pin/archive/folder state lives in a SEPARATE sparse table
`member_inbox_message_state` keyed by `(member_id, recipient_id)`. A delivered
recipient with NO state row is treated as unread / not-pinned / not-archived /
no-folder.

**source** = `'group'` when `email_campaign.member_group_id` is set, else `'admin'`.
`email_campaign_recipient` is deliberately NOT exposed via the generic entity API.

## Unread badge count is arithmetic, not a scan

Because "no state row = unread", you cannot count unread with a single filter.
The lightweight nav/dashboard badge endpoint uses three `head:true` count
queries instead of pulling rows:

```
unread = deliveredTotal - archivedStateCount - readNonArchivedStateCount
```

- deliveredTotal: count of the member's recipients with `sent_at` not null (inner-join filtered on `email_campaign.tenant_id`).
- archivedStateCount: state rows `is_archived = true`.
- readNonArchivedStateCount: state rows `is_read = true AND is_archived = false`.

**Why:** avoids enumerating every recipient just to show a number, and correctly
counts stateless-delivered rows as unread. Assumes every state row maps to a
delivered recipient (true in practice; the UI only acts on delivered messages).

## Opening a message auto-marks read — invalidate with EXACT keys

`GET /api/communication/inbox/[id]` renders the body AND upserts the state row to
read. The client query keys share the `["inbox", ...]` prefix
(`["inbox"]` list, `["inbox","unread"]` badge, `["inbox","message",id]` body).
After a body loads, invalidate the list + badge with `exact: true`, or a plain
`["inbox"]` invalidation also re-fires the body query and loops.

**How to apply:** any new inbox surface that reads a message must refresh the list
and badge with exact-key invalidation, never a prefix invalidation.
