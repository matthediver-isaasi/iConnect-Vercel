---
name: Zoom background scheduling
description: Queued Zoom registration needs an active deployed worker schedule, not just a deployed enqueue endpoint.
---
Verify the deployed background schedule independently of the event UI and worker endpoint.

**Why:** Vercel preview builds can expose the new queue and worker endpoints while the production project's active cron definitions still belong to an older production build. A queued job with cursor zero, no attempts and no lease has not been picked up; it is not evidence of a Zoom rejection. Disabling duplicate reconciliation is insufficient feedback in this state.

**How to apply:** compare the project's active cron definitions and their deployment with the current preview/production targets. Preserve the queued job; do not clear locks or enqueue duplicates to repair missing scheduling. Registration and confirmation-email consent remain separate.
