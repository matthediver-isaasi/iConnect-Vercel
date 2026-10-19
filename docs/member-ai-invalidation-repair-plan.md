# Repair Member AI rebuild invalidation and stale-claim recovery

## Repair delivery, 19 October 2026
- Applied `202612310010_iedit_invalidation_precision.sql` to DEST only with an
  exact pre/post function-definition guard in one transaction. No migrations
  remain pending for this repair. SOURCE untouched.
- Audited timestamp/no-op updates no longer invalidate content. Selected known
  dependency updates narrow by renderer presence; unknown changes and access
  changes remain fail-closed. Insert/delete and both old/new identities survive.
- Stale-generation/claim outcomes preserve the cursor and stop boundedly for a
  fresh-claim resume. Scheduled allowance is not replenished. Manual pause text
  now distinguishes contention from exhausted embedding allowance.
- Recovered GFI through the normal REST publisher with zero new embeddings,
  using `scripts/recover-gfi-iedit-reuse.mjs --apply`. This rereads canonical
  content and reuses matching embeddings; it does not force old rows active.
- Subsequent read-only verification: 52 of 55 source registries current; the
  remaining three have zero extracted/stored chunks (Contact us, Join us a
  partner, Academic Employability Awards 2026). No fabricated empty-content
  generation activation was attempted.
- People has 35 retrievable chunks, 11 mentioning Board, after normal access
  revalidation. This remained true on the later read-only check.
- Verification: 241 focused JS tests, two isolated PostgreSQL tests covering 34
  mutation cases, two selected existing lifecycle tests; diff check clean.
- Application restarted cleanly. Workspace screenshot still shows the existing
  SOURCE/default-tenant mismatch, so no signed-in UI or real model-answer claim.
- Worker and pause-message code still needs application deployment. The database
  invalidation repair and recovery are already live. Signed-in Board answer and
  longer-term stability monitoring remain unverified.

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
### Read-only recheck, 19 October 2026
- DEST still has 1,515 iEdit chunks, but none of its 55 GFI iEdit source
  generations is current. Saved source settings still enable iEdit.
- People retains 35 chunks at generation 190, 11 mentioning Board. Its source
  registry is now generation 309 with no active generation.
- Fresh guest extraction still yields 35 People chunks at `/our-people`.
  Extraction and source enablement are not the immediate blocker.
- The installed trigger still invalidates all tenant iEdit pages for every
  insert/update/delete on dependency tables, including member, organization,
  system_settings and tenant. The exact triggering write remains unproven.
- The global rebuild marker retains a run with its last heartbeat at
  14:52:57 UTC and no completed timestamp. This is stale progress evidence,
  not proof of why the request stopped. The 55 queued iEdit jobs have zero
  attempts and no recorded error.
- No claims, model/provider calls, writes or migrations were performed by
  this recheck. Signed-in model response verification remains outstanding.

### Implementation
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
