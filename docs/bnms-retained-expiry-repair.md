# Retained-expiry historical membership repair

## Scope and result

The owner approved six of the seven retained-expiry proposals on 14 October
2026. The unselected member was left unchanged. This repair did not include the
six previously repaired renewals or the separate online-only cohort.

Six historical rows were inserted into verified **DEST** Supabase
(`lvmzliemqnieeoruhkik`). SOURCE was untouched. No schema migration was needed,
applied, or remains pending.

- Three histories retain verified Xero cash payments and historical £128 prices.
- Two histories use the owner's paid-entitlement attestation, with unknown
  amounts, currency and payment dates, and no uncertain invoice links.
- One history records entitlement only, **not cash settlement**: its payment
  status remains unpaid, with unknown amounts and no invoice link. Existing
  credits and Direct Debit evidence were not changed.
- All commencement dates remain unknown. All six retained expiries remain in
  2026, with expired history status; no successor terms, renewal policies or
  collection consent were created.

## Application behavior

The report accepts the strictly bound historical evidence stored on the
membership history. There is no runtime member-ID/name inclusion list. This
does not broaden renewal authority, waive expiry, or change class routing.
The existing 90-day expired-membership allowance and successor precedence
continue to apply.

The application change must merge and reach the deployed application before
the live report can recognize this evidence shape. Database rows already exist;
do not rerun the apply command to deploy the report change.

## Verification

`scripts/repair-bnms-retained-seven.mjs` provides `verify`, `dry-run`, `apply`
and `replay` modes. It pins the original seven-member proposal, the approved
six-member contract and the private read-only audit. It revalidates source file
hashes, live source identity/date/DD state and existing histories. A still-fresh
completed provider audit may be reused without advancing its timestamp.
Provider evidence must be less than 30 minutes old for database operations.

The completed live sequence was:

1. Transaction rollback rehearsal: six validated inserts, zero committed writes.
2. Exclusive-create private before journal.
3. Transactional apply: six history inserts, no existing histories changed.
4. Post-commit validation and replay: six rows validated, zero writes.

Protected-table comparisons covered members, preferences, structures, agreements,
plans, GoCardless data, recognition, expiry policies and imported invoices.
Other members' report output remained identical. The 14 October projection
changed from 328 to 334 print recipients. This is a code projection over live
data, not a claim that the deployed report has already updated.

Private evidence and receipts remain under the ignored directory
`generated-artifacts/bnms-retained-seven/`; do not commit them or member data.

Tests:

```sh
node scripts/run-isolated-tests.mjs node --test \
  scripts/bnms-retained-seven-core.test.mjs \
  api/_lib/nmcMembershipReport.test.mjs
```

The signed-in production UI was not verified.
