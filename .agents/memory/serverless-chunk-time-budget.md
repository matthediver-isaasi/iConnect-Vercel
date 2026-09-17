---
name: Serverless chunk loops need a time budget, not just a record cap
description: Why browser-driven chunked backfills must bound each invocation by wall-clock, with an exact per-record resume cursor.
---

**Rule:** A resumable chunk endpoint on Vercel must stop on a wall-clock budget (~45s under a 60s maxDuration), not only on a record count. Cost per chunk is driven by *matched* records (each match = several sequential awaits), so a fixed `page_size` can still 504 when many records match.

**Why:** The workflow manual-backfill 504'd in execute mode on a tenant where ~all records matched — dry-run (no actions) was fine, so record-count chunking looked correct until execute ran.

**How to apply:**
- Budget check runs BETWEEN records (never mid-record); track processed-count within the current DB page so `nextOffset` points at the exact first unprocessed record, not the next page boundary.
- Keep the budget an opt-in option so cron/other callers are untouched.
- Client loop: a fixed max-chunk count is wrong once chunks are time-budgeted (a chunk may process very few records) — cap the loop by total wall-clock + a stalled-progress guard (nextOffset not advancing with 0 evaluated) instead.
- Client should retry a chunk on 502/503/504/network with backoff; on final failure tell the admin re-running is safe (executed records are logged; once-per-record workflows skip them).
- Verified pattern: monkey-patch the shared `supabase` object from `database.js` in an ad-hoc harness to unit-test `runScheduledWorkflow` offset arithmetic without a real DB (Node 20 has no `mock.module`).

**Rule:** Budget prerequisite retries and downstream completion separately, and expose partial progress instead of equating a returned invocation with successful work.

**Why:** Repeated manual payment sweeps spent their single prerequisite slot on old failed address mappings while newer paid submissions were skipped. Heartbeat-only failures were omitted from the JSON response, so callers saw successful invocations with no explanation for zero finalizations.

**How to apply:** Claim prerequisites sequentially within a bounded allowance, reserve enough time to start the downstream finalizer, and finish each owned lease. Return safe stage-level failure and waiting counts; never weaken immutable payment evidence or mapping checks just to clear a queue.

The downstream reserve must include its claim, form lookup and URL resolution overhead—not merely the finalizer's minimum stage-start threshold.

**Why:** Payment address recovery succeeded, but later completion receipts still reached the processor with less than its minimum start budget. Multiple queue claims looked like progress even though member creation never started.

**How to apply:** Judge progress by completed durable stages, not claim counts. A single-submission manual recovery can isolate an urgent receipt, but it does not prove that the global worker schedules later receipts fairly.
