---
name: Public directory field privacy
description: Privacy boundary for public features that reuse member-directory data.
---

Public member projections must enforce two separate policies on the server: whether a member may appear at all, and which front-facing profile fields the tenant allows.

**Why:** A current, directory-visible member may still have profile photo, job title, organisation, or other fields disabled by tenant directory settings. Hiding those fields only in React still exposes them in the browser response.

**How to apply:** For any public directory-derived presentation, filter row eligibility first, then project only fields whose front visibility is enabled. Return the narrowest response shape needed by that presentation.