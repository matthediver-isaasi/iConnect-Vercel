# Approved BNMS payment-backed membership restoration

## Authority and scope

The owner explicitly selected **“Approve all 19 with the listed dates”** after
reviewing the named subset and each proposed start/retained expiry. This is not
approval for the other 143 rows in the investigation.

Pinned original evidence:

- Recovery JSON SHA-256: `aef36ada4fb6af6d9c59bd95d35c8ebcb06478408adc34b036b983c82d68c6bc`
- Delivered 162-member CSV SHA-256: `1964b03d164d5c5e487768a058daef12abb180361bb0b62ab2d616ec649dff91`
- Fresh provider evidence SHA-256: `639ed504f246da16b67bc8c5664817005a6bb80606d4064bfca8d81a7545fdfb`

Private evidence and journals are excluded from Git and deployment under
`generated-artifacts/`. The report and source files were present; no approximate
cohort was recreated. Original import file hashes were also checked.

## Execution

Applied to verified **DEST Supabase project `lvmzliemqnieeoruhkik`** only.
SOURCE and the Replit database were not changed. **No schema migration was needed,
applied, or left pending for this repair.**

The runner follows the existing approved reconstruction pattern:

1. Reproduce the pinned individual assessments, including narrowly corroborated
   overseas wording; preserve the existing member class.
2. Refresh Xero contact identity, full invoice history, latest paid membership
   invoice, membership line and all authorised settlement payments via GETs.
3. Recheck live member attributes, legacy expiry, absent history, annual
   member-class structure and local Direct Debit evidence.
4. In a serializable transaction, lock protected tables, journal before-images,
   build exact historical-amount commitments and check all other rows unchanged.
5. Roll back the dry run, apply against the same provider evidence and approved
   member-state hash, then perform a zero-insert replay.

Results:

| Phase | History inserts | Committed | Other checked tables changed |
|---|---:|---|---:|
| Transaction dry run | 19 | No | 0 |
| Apply | 19 | Yes | 0 |
| Replay | 0 | No | 0 |

All 19 persisted commitments were checked using the Member Detail response
shaper: correct start, expiry, renewal boundary, structure, historical price and
current lifecycle. The production NMC report projection was exercised on live
database rows: all 19 changed from missing-membership-evidence review to
**Active / zero months expired / Online-only**. No print eligibility was inferred.

The signed-in browser screens were not verified. The unauthenticated workspace
preview reports “Tenant not found”; this repair did not alter app runtime code or
workspace tenant configuration. Data-level Member Detail and NMC checks are the
verification authority for this operation.

No provider invoices, payment requests, collection instructions, subscriptions,
renewal policies or future collection consent were created. Xero token maintenance
by the existing credential helper is separate from financial writes. Original
payment instrument and original purchase consent remain unknown, explicitly
recorded as such rather than inferred from settlement.

## Private receipts and output

Under `generated-artifacts/bnms-approved-19/`:

- `provider-1791969661423.json`
- `dry-639ed504f246da16b67bc8c5664817005a6bb80606d4064bfca8d81a7545fdfb.json`
- `receipt-apply-1791969721323.json`
- `receipt-replay-1791969737019.json`
- `before-*.json` — exact before-images, proposed rows and approval
- `BNMS-19-Restoration-Verified.csv` — per-member results for the owner

Committed operational code:

- `scripts/reconstruct-bnms-approved-19.mjs`
- `scripts/bnms-approved-19-core.mjs`
- `scripts/bnms-approved-19.test.mjs`

These are one-off guarded recovery scripts, not an application feature or cron.
Never rerun apply for this completed cohort. Replay requires fresh evidence within
30 minutes and rejects altered provenance; preserve existing receipts instead of
replacing them. Future repairs require their own explicit cohort/date approval.

Verification: 10 reconstruction/source-evidence tests and 13 NMC tests passed,
plus the live transaction dry run, committed-row verification and zero-write replay.
