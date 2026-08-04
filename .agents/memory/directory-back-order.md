---
name: Unified directory card-back ordering
description: Ordering of back-of-card fields for member & org directory cards is resolved by a client/server-duplicated helper
---
Back-of-card field order resolves directory override → tenant default → hardcoded default, and the resolver is intentionally duplicated in the client settings utils and the server directory-config mirror.
**Why:** guest/embed rendering gets its settings from the server mirror; a client-only change silently diverges for public visitors. A parity unit test asserts the two copies' constants match.
**How to apply:** adding a new orderable back element means updating BOTH copies plus every detail-dialog renderer (there are several: dynamic member/org dialogs, org directory page, standalone member profile modal). Ordering only sequences; visibility toggles still gate content. Header items (photo/name, logo/title) are pinned and not reorderable.

## Per-directory core-field visibility (added Aug 2026)
- `dynamic_directory.core_field_visibility` JSONB: `{ "<core key>": { front?, back? } }`; missing key/side inherits global Member Directory Settings; NULL = inherit all.
- Merge helper `applyCoreFieldVisibility` duplicated client (`directorySettings.js`) + server (`directoryConfig.js`) like the back-order resolver — keep in sync; parity covered in `directoryBackOrder.test.mjs`.
- Guest/embed paths merge SERVER-side into `displaySettings` (config endpoint + public embed endpoint); client re-merge is idempotent. Public embed's explicit column list had to add the new column.
- Org directories: only `back` side applies (`org_member_count`, `org_members_list` via `isOrgCoreItemVisible`); fallback preserves the existing `show_members_on_card_back` gate.
