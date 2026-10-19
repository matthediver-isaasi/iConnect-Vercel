# Repair Member AI rebuild invalidation and stale-claim recovery

## Goal
Keep completed iEdit knowledge available until a relevant content or access change
requires invalidation, and make rebuild interruptions recoverable without
publishing stale content or silently increasing embedding spend.

## Observed evidence
- GFI rebuilt 1,515 iEdit chunks, including 35 People-page chunks (11 mentioning Board).
- Later inspection found all 55 iEdit source generations invalidated.
- A reported page failure was `MEMBER_CONTENT_GENERATION_STALE: checkpoint write rejected`.
- The broad iEdit dependency trigger invalidates every tenant iEdit page for
  updates on many dependency tables, including member and organisation records.
- The exact cause of the final stopped HTTP request remains unproven. Do not
  label it a timeout without request/log evidence.

## Work
1. Audit installed DEST triggers and extractor dependencies. Identify which
   writes actually caused invalidation where evidence permits. Map relevant
   content, eligibility and permission fields; do not assume every member change
   is irrelevant.
2. Add a narrowly scoped migration to suppress invalidation for proven irrelevant
   updates and restrict affected pages where dependency discovery is complete.
   Preserve insert/delete, OLD and NEW tenant/parent moves, automatic-list
   eligibility changes, permissions, newly eligible records and removals.
   Unknown dependency changes must remain fail-closed.
3. Handle stale generation/claim outcomes as bounded deferred retries under
   fresh claims. Do not reuse stale metadata, publish incomplete pages, weaken
   fencing, or replenish the scheduled worker's chain-wide allowance.
4. Preserve accurate progress and cursor state, expose useful per-source
   failures, distinguish failed requests from expected contention, and make
   an explicit resume possible without an unbounded automatic retry loop.
5. Verify with isolated tests and rollback-only real-database fixtures:
   irrelevant updates preserve searchable generations; relevant content/access
   changes invalidate; concurrent invalidation rejects stale writes; fresh
   recovery completes; manual/cron spending and authority boundaries hold.
6. After code deployment and any approved DEST migration, run an explicitly
   authorised scoped GFI rebuild. Verify sustained source freshness under normal
   activity and test the signed-in “Who is on the GFI board?” response, including
   People-page citations. Do not claim success from extraction or mocks alone.

## Boundaries and delivery
- No content deletion, blanket reactivation, credential changes or provider calls
  as part of diagnosis/tests.
- Do not apply changes to legacy SOURCE.
- Report migrations required/applied/pending and deployment/backfill status.
- This is a saved implementation plan, not a queued project task.
