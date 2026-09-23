# BNMS trainee reconciliation

Task 4628 has a read-only reconciler for the 21-row, headerless trainee workbook:

```sh
node scripts/bnms-dd-trainee-reconcile-run.mjs
node --test scripts/bnms-dd-trainee-reconcile.test.mjs
```

Every execution reserves a new timestamped directory under `exports/private-bnms-trainee-reconciliation-*`. Files are created with exclusive-write semantics and mode `0600`; an existing run directory is rejected before any database or provider read. Private exports and the source workbook must not be published.

The unversioned development capture at `exports/private-bnms-trainee-reconciliation/` is superseded and must not be used for review or handover. Only the newest timestamped package whose post-save evidence, report, and envelope hashes independently verify is authoritative.

The intermediate timestamped package `exports/private-bnms-trainee-reconciliation-2026-09-23T093123084Z/` failed post-save canonical-hash verification and is also non-authoritative. It is retained only as immutable failed-run evidence.

## Current outcome

- The exact workbook and immutable original alpha artifacts are SHA-256 pinned.
- All 21 rows are authoritative destination Trainee members.
- Fresh tenant-owned GoCardless read-only verification completed.
- The 173 settled payments in the approved historical window map in the pinned old accounting evidence to revenue code `204`. Codes `200` and `201` remain the only approved codes, so an accounting decision is required for every row.
- Fresh Xero verification did not complete because the stored access token had expired. The reconciler does not refresh OAuth tokens and never treats old evidence as fresh.
- A prior Xero `Retry-After: 33701` checkpoint was considered. Its not-before time had passed before the current observation; no new Retry-After was received.
- No destination, GoCardless, Xero, source, alpha, pilot, or beta writes occurred.

The private run contains full row-level evidence, a human-readable row report, and `review-manifest-v1.json`. That manifest is a **blocked reconciliation envelope**, not an eligible supplemental cohort.

## Guard and handover policy

The original alpha, pilot, and beta cardinality/hash/immutability guards are unchanged. No adoption writer exists for these rows. Do not add one until:

1. the accounting owner explicitly decides code `204`;
2. a new immutable run obtains complete fresh Xero contact, invoice, payment, amount, currency, and period evidence;
3. at least one row passes every eligibility and cross-cohort collision gate;
4. a separate supplemental schema and writer are designed and reviewed with exact schema/data hashes; and
5. held adoption and release receive separate approvals.

No migration was needed or applied for reconciliation. A supplemental schema is not approved, designed, or applied while eligibility is empty. Collections remain held.

The reconciliation deliverable may be complete while provider/accounting verification and adoption remain incomplete; these states must never be conflated.