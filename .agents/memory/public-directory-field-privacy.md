---
name: Public directory field privacy
description: Privacy boundary for public features that reuse member-directory data.
---

Public member projections must enforce two separate policies on the server: whether a member may appear at all, and which front-facing profile fields the tenant allows.

**Why:** A current, directory-visible member may still have profile photo, job title, organisation, or other fields disabled by tenant directory settings. Hiding those fields only in React still exposes them in the browser response.

**How to apply:** For any public directory-derived presentation, filter row eligibility first, then project only fields whose front visibility is enabled. Return the narrowest response shape needed by that presentation.

Organisation-directory reuse must not treat an empty member-role list as publication consent, or treat domain visibility as permission to expose the core website URL or description.

**Why:** Legacy public handlers can return broader data than the directory's actual member-role and field policies permit. The directory's visible domain is derived from verified-domain preferences, not the organisation's general website field.

**How to apply:** Check the management policy and authoritative directory projection, rather than inferring permission from an endpoint being named public. For long inventory reads, revalidate the full visibility/eligibility authority before returning.