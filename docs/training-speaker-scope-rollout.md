# Training agenda speaker recognition: rollout gate

## Status and approval boundary

This change supplies forward-only migrations and isolated application/database/browser evidence. **No live database migration, customer allocation/conversion, provider operation, email, voucher backfill or historical certificate replacement is authorized by this task.** None has been performed.

Apply only after the owner separately approves the target environment, maintenance window and exact migration checksums. The workspace preview is not an isolated tenant database and must not be used to test financial effects or sends.

## Contract

- Only simple events with `is_training=true` use agenda appearances as award identities.
- An appearance is `(tenant, event, stable agenda item, speaker)`. Reordering never changes identity. A deleted item's identity remains in historical evidence, not a cascading foreign key.
- Ordinary simple events and complex events retain their existing event-wide identity.
- Existing event-wide training speaker arrays/configuration remain a **needs-allocation backlog**, not an active union or automatic award source. Selecting a speaker on one or more lines and resolving the backlog is an explicit administrator action.
- Copying old settings to a line is a separate, labelled editable-defaults action. There is no runtime inheritance from the event.
- No legacy grants or recognition rows are copied, split, relabelled, revoked or reissued by migration. Issued private PDFs remain create-only and retain their original recipient, snapshot, digest, path and authorization.
- The new policy timestamp excludes already-started agenda items from new effects. Parent start/completion timestamps do not suppress a later eligible line.
- Vouchers and certificates use the line's local start in the parent timezone. A date-only line starts at local midnight, ends at local 23:59, and uses the start date when the end date is absent. Nonexistent/ambiguous local minutes fail closed.
- A held badge credential can support several line entitlements. Existing/manual credentials are not duplicated. Allocation of an already-held badge alone does not send another badge notification. Explicit keep decisions and other remaining entitlements protect shared credentials.
- Speaker recognition is not attendance: no booking, attendance assertion, CPD ledger entry or numeric speaker-points scheme is introduced.

## Preflight: read-only, approved environment only

Record counts, not names, emails, private paths or snapshots:

```sql
-- Training scope and the manual-allocation backlog.
SELECT count(*) AS training_events,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(to_jsonb(speaker_ids),'[]')) > 0) AS events_needing_allocation
FROM public.event WHERE is_training;

SELECT count(*) AS agenda_items,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(to_jsonb(a.speaker_ids),'[]')) > 0) AS assigned_items
FROM public.event_agenda_item a JOIN public.event e
  ON e.id=a.event_id AND e.tenant_id=a.tenant_id WHERE e.is_training;

-- Baseline historical evidence: these counts must not change on schema apply.
SELECT g.status,count(*) FROM public.speaker_award_grant g
JOIN public.event e ON e.id=g.event_id AND e.tenant_id=g.tenant_id
WHERE g.event_type='event' AND e.is_training GROUP BY g.status;

SELECT r.certificate_status,count(*) FROM public.speaker_recognition r
JOIN public.event e ON e.id=r.event_id AND e.tenant_id=r.tenant_id
WHERE r.event_type='event' AND e.is_training GROUP BY r.certificate_status;

-- Reference representation and the actual uniqueness contracts.
SELECT table_name,column_name,udt_name FROM information_schema.columns
WHERE table_schema='public' AND column_name='speaker_ids'
  AND table_name IN ('event','event_agenda_item','complex_event_session');
SELECT conrelid::regclass,conname,pg_get_constraintdef(oid)
FROM pg_constraint WHERE conrelid IN
  ('public.speaker_award_grant'::regclass,'public.speaker_recognition'::regclass);
```

Also record orphan/foreign agenda parents and speaker references; resolve any inconsistent ownership **only under separate data-remediation approval**. Confirm active template references, parent timezones and minute-resolution line boundaries. Both native UUID arrays and JSONB reference schemas are exercised in disposable PostgreSQL.

The processing migration asserts the expected legacy recognition conflict clause before changing its partial-index target. A mismatch is a compatibility stop, not permission to modify the installed function blindly. PostgreSQL's shortened generated legacy recognition-constraint name is explicitly handled.

## Release sequence

1. Obtain approved target/environment evidence and checksums for all six `202701220001` through `202701220006` training-speaker migrations.
2. Pause speaker-award/recognition cron execution and editor writes. Drain in-flight workers, including notification and certificate attempts. A claim created before the migration must not still be fulfilling effects across the transition.
3. Apply the six migrations in order during the approved maintenance window. Do not expose the intermediate schema: the first migration changes uniqueness; the second installs the compatible ordinary/complex recognition conflict target and scoped processor.
4. Verify partial indexes, immutable scope/parent triggers, private artifact protections, service-only RPC grants, grant-table RLS, the new policy timestamp, and unchanged legacy grant/recognition/artifact counts. The policy timestamp is evidence, not a switch to move backwards for backfills.
5. Release the matching application and all workers together. Old event-wide training claim inserts are rejected at the database boundary. Old editor reconciliation requests cannot enable scoped processing without the versioned contract.
6. Resume writes and cron. Existing training events start with scoped processing disabled. The updated editor saves parent+agenda atomically, then explicitly finalizes recognition and assignment-time badge processing. A failed or unfinalized save cannot enable automatic effects.
7. Administrators allocate legacy backlog records deliberately. They may select one or several lines, review each line's independent awards and dates, then resolve and save. Do not run a script to fan legacy speakers onto every line.
8. Under separate approval, verify a designated upcoming event in the intended provider sandbox, followed by an explicitly authorized live smoke test if required. Do not infer real delivery from isolated fixtures.

The queue orders training events by their last attempt, rather than permanently taking the first identifiers. Notification leases/delivered stamps remain per grant and recipient; certificate retries remain independent of event/line completion. A processing failure rolls back that line's effects while allowing other lines to proceed.

## Rollback and recovery

Pause workers/writes first. Prefer a forward fix. Do **not** drop scope columns/indexes, restore the old global uniqueness, lower the policy cutoff, recreate vouchers, replace issued PDFs or collapse line grants into event records.

Rolling application code back alone leaves database guards in place: old training claim inserts fail closed, rather than issuing event-wide duplicates. Keep training-award workers paused until compatible code is restored. Historical ordinary/complex and certificate-reading paths remain supported. A database restore involving issued financial/artifact evidence requires separate reconciliation and owner approval; it is not an automatic rollback step.

## Reproducible isolated evidence

### Voucher-origin compatibility evidence (2026-11-24)

Task #5803 is a read-only compatibility release, **not installation of the
agenda-speaker schema**. The six-migration coordinated rollout remains owned by
task #5675. Do not apply `202701220001` alone to repair voucher display.

The investigation supplied with this task reproduced HTTP 400 / SQLSTATE 42703
for the grant projection on verified DEST using limit-zero reads (no customer
rows); the other endpoint projections succeeded. That is prior investigation
evidence, not a live request replay performed by this change.

The endpoint first selects snapshots. Only SQLSTATE 42703 naming precisely
`speaker_award_grant.agenda_snapshot` as nonexistent enables a request-local
legacy projection retry. The retry preserves tenant and voucher filters, ID
ordering, 200-row pagination and every linked origin. Later requests attempt
snapshots again, so no process restart or stale capability cache prevents
snapshot use after rollout. Missing source rows remain nullable metadata;
unrelated failures and failed legacy retries remain generic HTTP 503 responses.

Server diagnostics use the fixed `[voucher-award-origins]` tag with only
`stage`, validated `code` (or `UNKNOWN`) and `outcome`. Stages distinguish
`authorization`, `voucher`, `grants_snapshot`, `grants_legacy`, `speaker`,
`event` and `complex_event`; outcomes distinguish `legacy_fallback` from
`failed`. Do not add raw database messages, hints, details, stacks, request
bodies, identifiers or customer metadata to these logs.

Verification performed:

```sh
node scripts/run-isolated-tests.mjs node --test --test-concurrency=1 \
  api/admin/voucher-award-origins.test.mjs api/admin/voucher-members.test.mjs
# 32 passed; network/database access blocked by the isolated runner.
npx playwright test --config=tests/voucher-management.task5241.config.mjs
# 8 passed; intercepted fixture API responses, no customer/provider writes.
```

The schema-aware endpoint adapter rejects unknown selected columns and returns
only selected fields. Evidence covers both schema contracts, 202 legacy linked
origins across pages, missing sources, tenant isolation, authorization, generic
failure responses and redacted diagnostics. Browser evidence covers list/detail
display, retry, loading/missing distinctions and tenant changes.

**Deployed verification remains unperformed:** this fork was not published and
no authorized tenant-admin session was supplied. The unauthenticated local
preview showed “Tenant not found”; it is not evidence of authenticated voucher
behavior. After merge/release, use an authorized session on the approved target
to POST existing organisation voucher IDs to `/api/admin/voucher-award-origins`.
Record status and safe diagnostic stage/code only, verify cards/details and
retry behavior without modifying records, and repeat snapshot-title checks
after the coordinated rollout. Keep this evidence separate from fixture results.

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgres node --test --test-concurrency=1 \
  supabase/migrations/trainingSpeakerScope.test.mjs \
  supabase/migrations/speakerRecognition.test.mjs \
  api/_lib/zoomSpeakerSync.postgres.test.mjs

node scripts/run-isolated-tests.mjs node --test --test-concurrency=1 \
  api/_lib/trainingSpeakerAwards.test.mjs \
  api/_lib/speakerAwards.test.mjs api/_lib/speakerAwards.grants.test.mjs \
  api/_lib/speakerRecognition.test.mjs api/cron/grant-speaker-awards.test.mjs \
  api/admin/speaker-award-reconcile.test.mjs api/admin/speaker-award-contracts.test.mjs \
  api/_lib/speakerAwardHistory.test.mjs api/_lib/speakerAwardEmails.test.mjs \
  api/_lib/zoomSpeakerSync.test.mjs client/src/lib/eventAgendaPersistence.test.mjs \
  client/src/lib/speakerAwardLifecycle.test.mjs \
  client/src/components/SpeakerSelectionModal.mounted.test.mjs

npx playwright test --config=tests/training-speaker-scope.config.mjs
```

The browser test mounts the actual agenda editor and history components with intercepted requests. It covers independent settings, explicit allocation, reordering with stable identities and separate line labels. It does **not** verify a signed-in customer editor, production data, Mailgun delivery, storage-provider behavior, or a real Zoom webinar.
