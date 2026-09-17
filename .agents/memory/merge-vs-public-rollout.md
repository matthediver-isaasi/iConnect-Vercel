---
name: Merge is not public rollout
description: How to distinguish a runtime defect from a stale frontend deployment on public custom domains.
---

A merged feature can exist in current source and in live database/API payloads while the public custom domain still serves an older JavaScript bundle. Treat source merge, data availability, and frontend rollout as three independently verifiable states.

**Why:** A conditional address feature appeared correctly in the admin and its saved rule was returned by the public API, but the public site's hashed JavaScript asset contained neither the resolver configuration key nor the rendering branch.

**How to apply:** When a newly merged UI feature has no effect, fetch the public page's hashed script and check for a stable feature marker before changing runtime code. If the current local production build contains it and the live asset does not, publish/redeploy rather than inventing a code fix.

Background schedules and their target deployments must be verified separately from frontend/API rollout.

**Why:** Paid form receipts were queued without any worker attempts while the return UI expected background completion. The source configured minute-by-minute processing, but Vercel's active cron definition still pointed at an older deployment on an hourly schedule.

**How to apply:** Inspect the provider's active cron schedule and target deployment, not just the repository config. Queue attempt counts distinguish work not being picked up from processing failures. Do not replay payments merely to diagnose a stalled worker.