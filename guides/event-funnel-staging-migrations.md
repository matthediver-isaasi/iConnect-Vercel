# Event Funnel Staging Migrations

**Author:** Replit Agent
**Last Updated:** November 2026
**Module:** Event registrations and shared checkout

---

## Table of Contents
1. [Overview](#overview)
2. [Architecture and saved manifest](#architecture-and-saved-manifest)
3. [Staging application procedure](#staging-application-procedure)
4. [Safeguards and error handling](#safeguards-and-error-handling)
5. [Verification and external integrations](#verification-and-external-integrations)
6. [Troubleshooting](#troubleshooting)

## Overview

**Live application remains on hold pending a verified recovery plan.** The owner
initially requested a staging-first rollout, then permitted live migration
subject to a clear backout route. That conditional permission does not establish
backup availability, restore readiness or migration compatibility. No live
migration has been performed by this task.

### Recovery readiness

The detailed incident decision tree, rehearsal procedure and evidence checklist
are in [Event Funnel Recovery Runbook](event-funnel-recovery-runbook.md).
Run `node scripts/event-funnel-recovery-readiness.mjs` for the offline ordered
checksum inventory and current release blockers; it cannot execute migrations.

This document is a rollout outline, **not a tested production recovery plan**.
There is no approved production rollback script or verified restore rehearsal
record. Before live application:

- Verify the exact target and a restorable backup/recovery point, retention,
  restore destination, operator access, expected downtime and acceptable data
  loss. Rehearse restoration in isolation.
- Capture the pre-change schema, including replaced routines, triggers and
  grants. Prepare and test a backout for each possible committed migration
  boundary; a code rollback alone does not undo database changes.
- Resolve version collisions and rehearse the frozen manifest against the full
  baseline. Keep funnel publication/purchasing disabled during rollout.
- Define stop conditions, the responsible operator and checks proving ordinary
  booking and payment paths work after either migration or backout.
- If any funnel payments or registrations exist, preserve their evidence and
  reconcile uncertain provider payments. Do not drop their tables or blindly
  restore an earlier database: a restore could lose later ordinary bookings,
  and cannot reverse external charges. Prefer a tested targeted repair while
  new funnel purchases are disabled.

No backup, restore capability, recovery duration or production-safe reversal is
claimed to have been verified.

The funnel implementation remains incomplete and activation remains blocked.
The SQL has been exercised against disposable local PostgreSQL fixtures, not
applied to an application database by this task. Those tests are not evidence of
compatibility with a full staging or live schema. Continue development locally;
freeze a final migration manifest only once the implementation is ready.

## Architecture and saved manifest

The source SQL remains in `supabase/migrations/`. Apply neither a broad date glob
nor the entire directory: unrelated migrations have overlapping date prefixes.
Cancellation recovery now has a separate `/api/cron/event-funnel-reversals`
handler so invoice delivery cannot consume its whole execution budget. It is
**not scheduled**. Do not enable its schedule until the staged schema, permissions,
provider recovery checks and activation approval are complete. Disabling new
purchases must not disable recovery of already-authorized refunds.

The registration report can read/retry already-approved cancellation operations;
it does not authorize new cancellations or replace the remaining approval and
operational-cleanup integration.

These are the current forty-five files, in intended dependency order:

| Order | File under `supabase/migrations/` | Purpose |
|---|---|---|
| 1 | `202701230001_event_funnel_definitions.sql` | Definitions, versions, readiness |
| 2 | `202701230002_event_funnel_sessions.sql` | Owned resumable sessions |
| 3 | `202701230003_event_funnel_inventory.sql` | Shared inventory guards and holds |
| 4 | `202701230004_event_funnel_journey.sql` | Atomic journey changes |
| 5 | `202701230005_event_funnel_publication.sql` | Published entry and offer policies |
| 6 | `202701230006_event_funnel_payment_orders.sql` | Frozen aggregate payment orders |
| 7 | `202701230007_event_funnel_registration_commit.sql` | Registration conversion and outbox |
| 8 | `202701230008_event_funnel_training_reservations.sql` | Training fund reservations |
| 9 | `202701230009_event_funnel_voucher_reservations.sql` | Voucher reservations |
| 10 | `202701230010_event_funnel_group_fulfillment.sql` | Group-ticket fulfillment |
| 11 | `202701230011_event_funnel_maintenance.sql` | Expiry and retention |
| 12 | `202701230012_event_funnel_discovery.sql` | Unlisted discovery filters |
| 13 | `202701230013_event_funnel_purchase_policy.sql` | Standalone authorization guards |
| 14 | `202701230014_event_funnel_legacy_intents.sql` | Legacy pre-provider access journal |
| 15 | `202701230015_event_funnel_invoice_preparation.sql` | Leased immutable invoice preparation |
| 16 | `202701230016_event_funnel_invoice_delivery.sql` | Shared invoice delivery journal and protected booking links |
| 17 | `202701230017_event_funnel_quickbooks_delivery.sql` | Original QuickBooks queue handoff and multi-booking linkage |
| 18 | `202701230018_event_funnel_invoice_readers.sql` | Private shared-invoice report and original-purchaser download authority |
| 19 | `202701230019_event_funnel_owned_invoices.sql` | Expiring reservation-owner access to original checkout invoices |
| 20 | `202701230020_event_funnel_confirmations.sql` | Frozen per-registration confirmation plans and send-attempt evidence |
| 21 | `202701230021_event_funnel_confirmation_retention.sql` | Bounded redaction of delivered confirmation content after retention expires |
| 22 | `202701230022_event_funnel_integration_steps.sql` | Per-registration integration checkpoints and atomic notification scheduling |
| 23 | `202701230023_event_funnel_zoom_recovery.sql` | Provider intent journal, account/recipient deduplication and observed recovery |
| 24 | `202701230024_event_funnel_confirmation_receipts.sql` | Signed email receipts and lost-response reconciliation |
| 25 | `202701230025_event_funnel_inventory_evidence.sql` | Actual inventory debits captured atomically for future cancellation recovery |
| 26 | `202701230026_event_funnel_reversal_ledger.sql` | Serialized refund limits and durable card-refund write barriers |
| 27 | `202701230027_event_funnel_training_refunds.sql` | Atomic restoration to the original training-fund owner |
| 28 | `202701230028_event_funnel_voucher_refund_plan.sql` | Frozen voucher refund shares, including concurrent partial reversals |
| 29 | `202701230029_event_funnel_cancellation_commit.sql` | Transaction-scoped cancellation and recorded inventory restoration |
| 30 | `202701230030_event_funnel_reversal_recovery.sql` | Private recovery context and idempotent voucher refund receipts |
| 31 | `202701230031_event_funnel_issued_invoice.sql` | Immutable issued-invoice customer and tax evidence |
| 32 | `202701230032_event_funnel_credit_journal.sql` | Private credit creation and allocation write barriers |
| 33 | `202701230033_event_funnel_credit_producer.sql` | Original-invoice credit job creation with serialized prior-credit evidence |
| 34 | `202701230034_event_funnel_quickbooks_evidence.sql` | Issued QuickBooks customer, line and tax evidence capture |
| 35 | `202701230035_event_funnel_quickbooks_credit_authority.sql` | Frozen QuickBooks credit authority and provider-specific receipt identities |
| 36 | `202701230036_event_funnel_refund_options.sql` | Atomic reservation of immutable voucher replacement choices |
| 37 | `202701230037_event_funnel_reversal_worker.sql` | Leased cancellation recovery with durable completion evidence |
| 38 | `202701230038_event_funnel_selected_voucher_refunds.sql` | Preserve explicit partial-refund voucher selections |
| 39 | `202701230039_event_funnel_cancellation_approval.sql` | Atomic request approval, refund authority and durable cleanup queue |
| 40 | `202701230040_event_funnel_cancelled_delivery.sql` | Fence cancellation against new delivery grants and suppress unstarted work |
| 41 | `202701230041_event_funnel_cleanup_completion.sql` | Verify cleanup completion when provider access is absent and emails are suppressed |
| 42 | `202701230042_event_funnel_cancellation_notifications.sql` | Private cancellation message journal and immutable original recipients |
| 43 | `202701230043_event_funnel_shared_zoom_cleanup.sql` | Retain verified Zoom access needed by confirmed sibling registrations |
| 44 | `202701230044_event_funnel_zoom_revocation.sql` | Serialize final access revocation and preserve historical grant generations |
| 45 | `202701230045_event_funnel_credit_emails.sql` | Durable original-company credit-note PDF email delivery |

These files depend on existing event, commercial capacity, unified booking,
voucher, public-ticket purchase and invoice-address-policy schema. Several
migrations inspect or replace existing routines. Missing dependencies or changed
function definitions must stop application, not be patched around blindly.

**Version collision warning:** Prefixes such as `202701230001` and
`202701230003` are also used by unrelated files. Before using migration-history
tooling, assign collision-free versions to this unapplied batch, update its test
references and manifest, and rehearse that exact revised chain. Do not rename
already-applied historical migrations or run a generic database push.

| Reference | Purpose |
|---|---|
| `docs/event-funnel-orchestration-contract.md` | Current implementation and remaining gates |
| `scripts/post-merge.sh` | Dependency installation only; automatic migrations suspended |
| `api/_lib/eventFunnelInventory.postgres.test.mjs` | Disposable local database scenarios |

## Staging application procedure

1. **Wait for explicit approval.** Record the staging project identity and
   independently verify its database endpoint is not DEST. Do not infer staging
   from a variable name, preview URL, or existing linked CLI project.
2. Provision separate staging application credentials and database access through
   the approved secrets process. Never copy credentials into this guide or logs.
   Migration tooling must fail when staging configuration is absent; no DEST or
   generic database fallback is permitted.
3. Establish a sanitized staging baseline and verify the full prerequisite
   migration history. Preserve installed routine definitions, privileges,
   constraints and relevant capacity/funding invariants for comparison.
4. Create a recoverable staging snapshot and record the restore procedure.
   Isolate payment, accounting, email, Zoom and scheduled workers from live
   services before any application testing.
5. Finish the implementation, resolve version collisions, and freeze the exact
   reviewed filenames, checksums and source revision. Update the manifest above
   if further migrations are added. Do not apply this evolving draft batch.
6. Use an explicitly staging-targeted migration mechanism that stops at the
   first error. Rehearse the complete approved chain in the listed dependency
   order. Respect each file's transaction boundaries and record which files
   committed; the batch is not one all-or-nothing transaction.
7. Keep purchasing/publication disabled while deploying matching staging readers
   and recovery workers. SQL installation alone does not authorize activation.
8. Run the verification below, inspect failures and exercise recovery. Obtain
   staging acceptance before considering any production release.

**No live application command is provided intentionally:** the staging identity,
baseline, final manifest and implementation are not yet ready. When they are,
prepare an explicit target-verified runner rather than reuse a DEST runner.

## Safeguards and error handling

- Do not run `scripts/post-merge.sh` as a migration launcher. Its automatic
  migration calls have been disabled by an unconditional exit after dependency
  installation; the existing SQL, runner files and historical commands remain.
- Previously automatic form-width, ticket-organisation-type, project-list-order,
  Zoom registration/confirmation, and custom-object report migrations are also
  suspended. Do not silently restore those calls during unrelated setup work.
- Do not run `npm run db:push`, a linked-project push, or old `apply-*` scripts
  against this unverified environment.
- A failed migration is a stop condition. Capture the error and committed
  manifest position without secrets; restore the staging snapshot or prepare a
  reviewed correction. Do not assume every migration is rerunnable.
- There is no approved production rollback script. Do not drop financial,
  booking or hold tables to undo a partial application.
- Application changes and this post-merge safeguard reach the main project only
  after this task is merged. This task has not changed the main deployment.

## Verification and external integrations

The following runs against disposable local databases, **not staging or DEST**:

```sh
node scripts/run-isolated-tests.mjs --allow-local-postgrest --allow-local-postgres \
  node --test api/_lib/eventFunnel*.test.mjs shared/eventFunnel*.test.mjs
```

For the later staging rehearsal, verify service-only grants, ownership,
cross-tenant denial, publication races, real API discovery filtering, capacity
competition, fixed expiry, route pruning, funding, group multipliers, payment
recovery, both invoice modes and allocation-aware cancellations. Also exercise
the unchanged standalone, commercial and historical purchase paths.

Use sandbox providers only with separate approval. An app preview is not database
or provider isolation. Browser and fixture evidence does not demonstrate a live
charge, a received invoice, or a production-safe rollout.

```text
Saved SQL and instructions
  → Approved, isolated staging identity
  → Verified baseline and recoverable snapshot
  → Frozen manifest and complete migration rehearsal
  → Matching readers/workers and staging tests
  → Staging acceptance
  → Separate explicit decision about live deployment
```

## Troubleshooting

### Staging is not ready
Keep the SQL unapplied and continue isolated development. Do not use DEST.

### Migration tooling reports duplicate versions
Resolve the unapplied batch's version collisions and update references before
rehearsal. Do not push all files sharing a date prefix.

### A prerequisite routine is missing or has changed
Compare the staging baseline with the expected dependency chain. Do not bypass
the migration's assertions or invent placeholder production functions.

### The feature still cannot be published
This is expected while implementation, schema, reader, worker and recovery gates
are incomplete. Do not flip readiness to bypass missing functionality.
