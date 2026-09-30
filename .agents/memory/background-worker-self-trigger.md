---
name: Background worker self-trigger vs heartbeat lock
description: Why a self-triggering chunked worker needs a handoff bypass on its freshness/heartbeat concurrency lock.
---

# Self-triggering background workers and the heartbeat lock

Chunked background workers (cron-dispatched Vercel functions that process one
time-budgeted slice per invocation and then re-trigger themselves to continue)
use a heartbeat-based concurrency lock: "if the job is `processing` and its
`heartbeat_at` is fresher than N seconds, another invocation owns it, so defer."

**The trap:** each slice writes a fresh heartbeat right before it self-triggers
the next slice. The successor then loads the job, sees a heartbeat that is
milliseconds old, and the freshness lock rejects it as a duplicate. The chain
stalls after one slice and only resumes at the cron's stale window (minutes
later) — fine for a tiny job, catastrophic for one that needs hundreds of slices
(e.g. a 50K-row import).

**The fix:** distinguish the chain's *own* continuation from genuine duplicate
kicks, and make the claim atomic. The self-trigger URL carries a marker
(e.g. `&handoff=1`). The claim is a single conditional `UPDATE ... RETURNING`
(compare-and-swap), not read-then-update — read-then-update lets two invocations
pass the same freshness check and both process the same slice:
  - **handoff continuation:** CAS on the *exact* heartbeat value it observed
    (the predecessor's). Concurrent duplicate handoffs race on that value; the
    first flips it, the rest match zero rows and defer. This is what makes the
    bypass safe — it is not an unconditional skip of the lock.
  - **cron / enqueue / manual kick:** CAS on `status = queued OR heartbeat
    stale`. A fresh job matches zero rows, so the live chain is never disturbed;
    only a genuinely dead chain (stale heartbeat) is revived.
Proceed only if exactly one row is returned. Also treat a failed progress write
as a hard failure (do not self-trigger), or the next slice reprocesses
un-advanced rows and double-inserts.

**Why:** without the bypass, throughput collapses to ~one slice per cron tick.
The form-submission-export worker is largely cron-paced and tolerates this; a
large import is not, so it needs the handoff bypass to self-drive to completion.

**How to apply:** any time you build a self-re-triggering chunked worker with a
heartbeat/freshness lock, add a handoff bypass on the lock for the continuation
request. Keep the cron backstop respecting staleness so a dead chain still gets
revived.
