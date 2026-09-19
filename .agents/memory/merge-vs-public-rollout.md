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

Custom development domains can serve the latest preview while scheduled jobs still target an older production deployment against the same database.

**Why:** The development-domain aliases served updated payment acknowledgements, but all queued completion receipts remained unattempted because the registered cron target had not changed.

**How to apply:** Verify the exact user-supplied hostname's alias-to-deployment routing alongside the cron target. Production can also be newer than a branch-pinned development domain: check its actual API route and bundle rather than substituting the tenant's public domain. A successful browser test on a development domain does not verify background execution. Do not promote an entire preview or run production recovery without accounting for its wider effects.

Vercel's deployment `source` describes how deployment was invoked, not whether its content came from Git.

**Why:** Git-backed deployments can report `source: "redeploy"` or omit it for API requests. Requiring `"git"` incorrectly rejects valid production proof.

**How to apply:** Pin `gitSource.type`, repository ID and commit SHA, then independently check the active production target, READY status and deployed commit's source hashes. Do not weaken those checks to accommodate the invocation label.