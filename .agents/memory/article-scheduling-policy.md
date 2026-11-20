---
name: Scheduled article visibility
description: Publication time must govern all reader-facing article paths while preserving editor and preview access.
---

Future-dated published articles are scheduled, not publicly available. Treat the exact publication instant as live and retain historical undated published articles.

**Why:** Scheduling already persists a future date under Published status; status-only readers exposed scheduled posts immediately. Introducing a second scheduling status or requiring a cron transition would unnecessarily change that contract.

**How to apply:** Apply the release boundary to public and ordinary-member reads, direct URLs and slug fallbacks, search, crawler content, metadata and sitemaps. Preserve author/admin editor access and separately authorized previews. Keep date predicates alongside tenant, audience and slug predicates; async helpers must wrap query builders rather than returning them directly.
