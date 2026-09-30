---
name: Dashboard widget cache authority
description: Evidence rules for cached widget status and unchanged numeric publications
---

# Dashboard widget cache authority

- Stale or overdue work is not active work; status must distinguish work that is currently running from work that has merely aged past its expected completion.
- An unchanged numeric result is publishable only with durable evidence linking the request to the publication (for example, a persisted request/version correlation), not because the number happens to match.
- Old success or pending flags are not publication evidence: they can describe an earlier request, survive a retry or timeout, and say nothing about whether this request reached durable publication.