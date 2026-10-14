# BNMS unexpired missing-history review — 14 October 2026

## Outcome

Read-only review of the exact 150 non-Former, imported Active members in the private
14 October missing-evidence audit, with unexpired retained expiry, no recorded DD
exclusion, `requires_term_and_invoice_review`, and outside the original
September–December 2026 window. No membership, provider, collection or renewal
writes were performed. No schema migration is required or outstanding.

All 150 remain **held pending explicit approval and paid-entitlement evidence**.
The separately repaired individual and earlier cohort approvals are not payment
confirmation for this cohort.

## Pinned evidence

Private artifacts are excluded from Git and deployment:

- Audit: `generated-artifacts/bnms-missing-history-review/receipt-1791962083646.json`
- Live snapshot: `generated-artifacts/bnms-missing-150-review/snapshot.json`
- Final proposal: `generated-artifacts/bnms-missing-150-review/final/proposal.json`
- Member review: `generated-artifacts/bnms-missing-150-review/final/member-review.csv`
- Readable proposal: `generated-artifacts/bnms-missing-150-review/final/proposal.html`

Proposal SHA-256:
`828d60e1756255a18e69064991427d5a628e24c1bab2655b1e7e8a84ed5342b0`

Snapshot SHA-256:
`b912478d69f5a7e2444266c5e68fa37a4e5376aff5a9247706608aed6df3f62e`

Only `final/` is the approval deliverable; earlier local draft outputs are not
approval targets. The JSON pins audit bytes, source files, matched worksheet
rows, live member evidence, historical invoice rows and a conditional repair
projection for every member. It is deliberately not an executable write manifest.

## Findings

| Finding | Members |
|---|---:|
| Reviewed original source fields corroborate retained evidence | 127 |
| Source class/type/status differences | 19 |
| Source expiry differences | 2 |
| No match in reviewed original membership files | 2 |
| Live audit drift / already-created history | 0 |
| At least one historical invoice | 135 |
| Archived invoice-number match labelled PAID | 115 |
| Historical invoice description mentions DD | 9 |
| Verified paid entitlement through retained expiry | 0 |
| Ready to apply | 0 |

Invoice findings overlap; do not sum them as exclusive cohorts.

Classes: Full 39, Trainee 34, Student 28, Full junior 17, Associate 12,
Overseas Full 11, Overseas associate 5, Overseas Full junior 4.
Retained expiry range: 1 January 2027–1 July 2030.

All 279 selected historical invoice rows were traced to the exact original
invoice workbook hash, worksheet and row; member UUID and invoice number were
checked. All have null local status and currency. The archived invoice export
covers 1 January 2025–12 August 2026. Its PAID labels and invoice numbers are
historical leads, not provider revalidation or current term coverage.

The original membership sources reviewed include Student, Overseas, UK
individual, Additional individuals, final 79, and September 28 workbooks.
Some source differences are older overseas class names, not erroneous expiry.
Duplicate source copies are not independent corroboration. Source matches do
not establish which import operation wrote a record. Missing evidence is not
proof that a member has not paid.

No live provider access or token refresh was performed. The review establishes
the available source evidence and its limitations, not fresh settlement.

## Conditional repair and approval requirements

1. Name the member-ID subset and the proposal hash explicitly.
2. Supply coverage/payment evidence or explicitly attest that each selected
   member is paid through their listed retained expiry. Keep operator attestation
   distinct from provider settlement.
3. Resolve source/identity conflicts and historical DD-description holds for
   affected members before authorizing any repair.
4. A separately authorized repair may establish an expiry-only historical
   membership with the retained membership type. Preserve unknown commencement,
   historical amount, currency, invoice linkage and payment timestamp. Do not
   use Member Since or expiry minus one year to invent a term.
5. Revalidate live source, DD exclusions and absence of history before writes.
   Changed or already-repaired members must be excluded and re-reviewed.
6. Do not create renewal policies, successor terms, collections, billing consent,
   provider objects, access changes or role changes.

The current conditional projection deliberately sets no paid status.

## Reproduction and checks

- `node scripts/review-bnms-missing-150.mjs` captures only DEST in a
  repeatable-read, read-only transaction, validates BNMS identity, and rolls back.
  No apply mode exists. It refuses to overwrite the existing snapshot.
- `python scripts/prepare-bnms-missing-150-review.py` performs offline source
  matching and produces private proposal files, refusing to overwrite them.
  Requires the project's available `openpyxl` Python package.
- `python scripts/test-bnms-missing-150-review.py`: passed three checks, including
  original file hash verification and all 150 members' held/null-authority fields.
  In environments without private evidence the output check is explicitly skipped.
- `node --check scripts/review-bnms-missing-150.mjs`: passed.

No application UI or runtime behavior was changed, so no browser verification
or application restart was required.
