---
name: Unified directory card-back ordering
description: Ordering of back-of-card fields for member & org directory cards is resolved by a client/server-duplicated helper
---
Back-of-card field order resolves directory override → tenant default → hardcoded default, and the resolver is intentionally duplicated in the client settings utils and the server directory-config mirror.
**Why:** guest/embed rendering gets its settings from the server mirror; a client-only change silently diverges for public visitors. A parity unit test asserts the two copies' constants match.
**How to apply:** adding a new orderable back element means updating BOTH copies plus every detail-dialog renderer (there are several: dynamic member/org dialogs, org directory page, standalone member profile modal). Ordering only sequences; visibility toggles still gate content. Header items (photo/name, logo/title) are pinned and not reorderable.
