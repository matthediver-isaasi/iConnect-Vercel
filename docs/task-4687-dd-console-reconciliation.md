# Direct Debit console reconciliation — task 4687

Read-only production DEST checks: **2026-09-22 09:33:29 UTC** and **09:33:42 UTC**.
Both returned identical aggregate counts. These are database checks, not authenticated
deployed-console verification.

## Method and boundaries

`node scripts/reconcile-bnms-dd-console.mjs` uses the existing destination origin,
SQL host/user and verified TLS pins. Each run uses a repeatable-read, read-only
transaction with 30-second statement and 3-second lock timeouts, ending in rollback.
Only aggregate counts leave the database. No provider requests, database mutations,
collection releases, deployment changes, or historical record repairs occurred.
Operational context was read from `replit.md` and the pinned adoption/connection scripts.

## Findings

| Cohort | Adoptions | Intact member/agreement/plan/history links | Deleted/missing members | Outside legacy first 200 |
|---|---:|---:|---:|---:|
| Pilot | 1 | 1 | 0 | 1 |
| Beta | 10 | 10 | 0 | 10 |
| Alpha | 249 | 249 | 0 | 70 |

All **260** imported adoptions have intact canonical linkage and non-anonymised
members. The unfiltered console's old 200-plan window excludes **81** of them.
The deterministic diagnostic adds an ID tie-breaker to the old updated-time ordering;
the legacy implementation itself had no tie-breaker. Search/pending-activation
filtering after this window cannot recover omitted plans.

There are **281** tenant plans:

- GoCardless: 262 first-payment-pending (3 deleted-member plans), 1 active
  (deleted-member plan), and 1 mandate-pending.
- Stripe: 17 active plans, all linked to anonymised members.

Thus a GoCardless-only console excluding anonymised members has **260** eligible
plans at this snapshot. Deleted records are identified by the existing
`deleted_…@deleted.local` marker, not by directory visibility or paused status.
Do not delete or rewrite these excluded financial records.

All 249 alpha and 10 beta plans remain first-payment-pending, collection-stopped,
and release-required. The pilot's collection-stopped/release-required flags are
not set; its observed lifecycle differs and must not be reset by a visibility fix.
No cohort has an `active` membership-history row in this snapshot.

Discovery has **899 rows**, **758 matched rows**, **304 matched rows whose member
has no canonical plan**, and **43 deleted-member matches**. These are row counts,
not distinct-member counts. A discovery match is not proof of adoption; canonical
imports must be reported separately. No new adoption is justified by this report.

## Rollout verification blocker

The deployment service reported no active **Replit** deployment. This does not
establish the status of the project's external Vercel deployment. A read-only
Vercel project-list request using the available credential returned HTTP **403**,
so the current external build/commit and authenticated console behavior could not
be verified. Deployment was neither attempted nor changed. An authorized Vercel
deployment check and authenticated production-console verification remain required
before claiming the fix is live.

These two unchanged snapshots prove read-only reconciliation stability only; they
do not prove that any subsequent code changes have reached production.

## Schema and verification

No database migration is required, applied, or pending for this visibility change.
Historical financial/import records and collection permissions are unchanged.
Local isolated regression and browser fixture results must be kept separate from
the production database findings above and from authenticated rollout verification.