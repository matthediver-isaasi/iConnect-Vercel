---
name: Platform manual backup orchestration
description: Why the manual R2 backup trigger completes via the browser loop, not server self-chaining
---

The platform super-admin "Backups" tab (`/platform/admin`) triggers the same R2
storage/database backups as the daily crons, but completion is **driven by the
browser**, not by the server re-triggering itself.

The rule: each call to `POST /api/platform/backups/run` runs exactly ONE
resumable chunk (bounded by a time budget) and returns its cursor state
(storage: `deferred`, database: `complete`). The client component
(`client/src/pages/platform/BackupManagement.jsx`) loops, re-invoking `/run`
until storage `deferred===false` / database `complete===true`, accumulating
progress for the UI.

**Why:** Vercel serverless functions have a hard maxDuration cap (300s here).
A full backup can exceed that, so the work must be chunked. Driving the loop
from the browser keeps each invocation safely within budget and gives live
progress, without a self-re-triggering server worker (contrast the
background-worker-self-trigger pattern) which adds heartbeat-lock/handoff
complexity not needed when a human is watching the tab.

**How to apply:** Any new long-running platform-admin job that must finish
while a super-admin watches should follow this shape — a single-chunk resumable
endpoint + a client loop reading the returned cursor — rather than server
self-chaining. The shared runners live in `api/_lib/backupRunner.js`.
