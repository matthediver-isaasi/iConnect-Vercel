---
name: Private (unlisted) events
description: Owner-defined scope of the Private event toggle — which listing surfaces hide it and which must keep showing it.
---

A Private event stays fully active (direct link, booking, emails, reports) and is only unlisted: hidden from /Events, the public event list pages, group event lists, site search and sitemap/crawler list output. On /Events, private events are hidden by default and can be exposed with "Show private events", using the exact same RBAC as "Show drafts only", not event-create access. Existing edit permissions still apply.

**Why:** On 2026-11-25 the owner asked for this, and explicitly required Canvas page event widgets to KEEP showing private events because tenants will build their own CMS pages for them.
The owner subsequently requested an explicit calendar toggle beside the drafts toggle so authorised users can locate private event cards for editing.

**How to apply:** Never filter private events in shared event data hooks or Canvas block queries (including the prerender canvas event-list); filter only at listing surfaces. This is discovery, not access control. The columns must exist in the database before the code ships, because editors always send `is_private`.
