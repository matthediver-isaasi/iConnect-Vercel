# Event Funnel Recovery Runbook

**Author:** Replit Agent  
**Last Updated:** November 2026  
**Module:** Event registrations and shared checkout

## Contents
1. Status and authority
2. Required evidence
3. Incident decision tree
4. Backout rehearsal
5. Provider restore and reconciliation
6. Verification and release gate

## 1. Status and authority

**Not approved for live execution.** This is an operational plan, not a tested
SQL rollback. No production restore point, restore duration or full-schema
backout has been verified. Do not interpret this document as proof of recovery.

The owner's permission to migrate live is conditional on a clear recovery route.
Do not apply the current draft batch while the feature remains incomplete.
Automatic post-merge migrations remain disabled. This plan supplements
[the migration manifest](event-funnel-staging-migrations.md).

## 2. Required evidence

The release operator must record the following in a private operational record,
not credentials or customer data in this repository:

| Evidence | Acceptance condition |
| --- | --- |
| Target | Independently verified Supabase project identity and database |
| Recovery point | Provider-confirmed restorable point immediately before rollout, within retention |
| Restore rehearsal | Isolated restored target, measured duration, completed verification |
| Data-loss agreement | Owner-approved tolerance; no assumption that daily backups are sufficient |
| Schema baseline | Exact pre-change routine definitions, triggers, privileges, constraints and migration history |
| Batch | Ordered filenames and SHA-256 hashes, collisions resolved, exact source revision |
| Partial backout | Rehearsal after each of the forty-five committed boundaries |
| Confirmation recovery | Signed delivery/failure receipt rehearsal with the original recipient and server-issued correlation token |
| Old application | Known compatible application revision, deployment operator and procedure |
| Side effects | Workers, webhooks, payments and accounting reconciliation procedure |
| Accountability | Incident commander, database operator, application operator and reopening authority |

Supabase's [backup documentation](https://supabase.com/docs/guides/platform/backups)
states that restoring makes the project inaccessible, downtime depends on database
size, and database backups do **not** restore Storage API objects. Do not assume
PITR is enabled from the subscription tier. Check **Database → Backups** for the
actual project and record its earliest/latest recoverable points in UTC.

## 3. Incident decision tree

**Stop immediately** for migration errors, unexpected schema differences,
permission failures, booking-capacity regressions, payment reconciliation
failures or unexplained financial differences. Never continue to the next file
after an error, or retry an unknown partially committed batch blindly.

1. Stop the rollout. Record the last confirmed committed file and exact error.
2. Block new funnel journeys and new payable checkouts. Do not release stock
   belonging to potentially paid orders. Keep payment-reconciliation evidence.
3. If ordinary registrations are affected, use a maintenance window to pause
   affected booking writes as well. A UI banner alone does not stop API writers.
4. Classify the incident:

| State | Recovery route |
| --- | --- |
| Current file failed before COMMIT | Confirm its transaction rolled back; prior files remain installed |
| Schema installed, no funnel financial activity | Use only the baseline-specific, rehearsed schema backout; roll back matching application |
| Payable, uncertain or confirmed funnel orders exist | Preserve tables, allocations, holds and outbox; reconcile providers and prefer targeted repair |
| Widespread corruption/no safe targeted repair | Owner approves provider restore, downtime and data-loss/reconciliation plan |

**Never** use `DROP ... CASCADE`, delete order tables, clear payment identifiers,
replay charges or discard funding records as an emergency rollback shortcut.
Application rollback alone is insufficient because the batch modifies existing
capacity routines and attaches triggers to ordinary booking/funding tables.

## 4. Backout rehearsal

Use an isolated representative baseline with live providers, outgoing mail and
scheduled workers disabled. A fresh empty Supabase branch is not automatically
a production-equivalent baseline.

For each committed prefix of the exact manifest:

1. Restore the isolated baseline using the provider-supported restoration path.
2. Capture baseline routines, trigger definitions, grants and constraints.
3. Apply only that prefix; record transaction outcomes and timings.
4. Produce the corresponding targeted reversal from the captured baseline,
   restoring modified routines and removing only the new attached triggers
   authorized by that reversal. Preserve ordinary bookings made after rollout.
5. Test reversal atomically with lock/statement timeouts; concurrent writes must
   be quiesced. Abort on any drift from the expected installed definitions.
6. Compare schema authority and permissions with baseline and rerun ordinary
   simple/complex, group, commercial allocation and funding scenarios.
7. Repeat with a new ordinary booking after migration and prove it survives.
8. Repeat with payable/uncertain/confirmed funnel evidence: destructive reversal
   must refuse, preserving the financial records for forward recovery.

**No generic down script is supplied:** the actual pre-change routine bodies
and privileges are required. Guessing them from old migration source could
overwrite later live fixes. This rehearsal remains outstanding.

## 5. Provider restore and reconciliation

Only an authorized operator may initiate a restore. Do not call a generic
project restore action without an explicitly selected recovery point.

Before restoring:

- Pause writes and worker dispatch; record the incident cutoff in UTC.
- Preserve post-cutoff payment intent, webhook, refund, invoice and funding
  evidence in approved private operational storage.
- Record the actual provider restore point, affected interval and approved loss.
- Inventory external subscriptions/replication requirements and Storage object
  changes using Supabase's restoration instructions.

Restore the selected point through the verified provider process. Keep traffic
closed until the compatible application and schema are verified.

Reconcile external payments across the affected interval against restored
orders/bookings. A missing booking is not evidence a payment failed. Resolve
each paid/uncertain order without charging again, duplicating invoices or
double-consuming credit. Verify provider/accounting idempotency before replaying
webhooks or outbox work. Any unresolved paid-but-missing booking blocks reopening
its purchase flow.

## 6. Verification and release gate

Before reopening, compare booking totals, event/ticket availability, commercial
commitments, group multipliers, funding balances, order allocations and invoice
links. Test member and guest permissions and ordinary booking completion.
Check that hidden offers remain protected and no duplicate side effects occur.
Record reconciled exceptions and obtain operator sign-off.

An offline evidence-completeness checker is available:

```sh
node scripts/event-funnel-recovery-readiness.mjs
node --test scripts/event-funnel-recovery-readiness.test.mjs
```

The first command prints the current ordered checksums and blockers, exiting 1
while blocked. It has **no database connection or migration execution path**.
It can accept a private JSON evidence file as its only argument. Evidence keys
are defined in `evaluateRecoveryEvidence` in that script. Populated evidence
allows operator review only: strings are attestations, not automated proof of
backups, restoration or production safety.

Do not store credentials, connection strings, tokens, customer data or private
backup URLs in that file. Regenerate evidence whenever a migration hash/order
changes. Do not bypass the gate to accommodate an evolving draft.
