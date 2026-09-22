# BNMS non-DD membership — completion report

Evidence checked on 22 September 2026. The reviewed pilot and the explicitly
approved 82-member cohort have been applied to verified DEST.

## Destination and scope

- Verified DEST tenant ID `ff2df806-b321-4254-b651-3af11fccf1db`, slug `bnms`.
- Pilot member `d91d8aa3-4981-4ba0-b923-ab6ccb092f9f`.
- Pilot canonical membership-history rows: **0 before; 1 after**.
- SOURCE membership data and schema were not changed. A helper initialization
  initially targeted the workspace's legacy connection and failed a token-column
  lookup; provider-helper processes were subsequently pinned to DEST at startup.

## Legacy evidence

| Field | Retained value |
|---|---|
| YM member ID | 56480498 |
| Status | Active |
| Expiry | 29/09/2026 |
| Membership type | Full Membership Overseas |
| Class | Overseas Full |
| Explicit non-DD flag | Missing |
| Term commencement | Not evidenced by these fields |

No rows were found for this member in billing agreements, payment plans,
GoCardless customers, matched mandate discovery, alpha/beta adoptions, pilot
imports or historical DD payments. These negatives do **not** establish a
non-DD payment method or complete provider-level DD exclusion.

## Xero identity and payment evidence

BNMS connection organisation: `3d57dce6-2205-462f-abf6-9c7cbf00be23`.
The existing tenant token helper successfully refreshed its expired connection.
This was credential maintenance only; no contacts, invoices or payments were changed.

Two active contacts share the member email. One has the exact retained YM
account number: contact `b181a1d3-be32-4098-a316-1c1120477e1a`.
The other, `3202507e-7828-48fc-bacd-b9b8bd3c281e`, has no account number and
an encoding-damaged name. A subsequent complete single-page invoice read found
one 2023 education-event invoice, tracked as Online Edu Series rather than
MEMBERSHIPS. It does not supersede the membership candidate.
No merge or identity reassignment was made.

Seven invoice metadata records were checked on the exact YM/email contact.
The latest paid membership candidate is:

- Invoice **300004629**, ID `946eb930-d00b-4400-a1be-0138c01fcc55`.
- Invoice date **22 September 2025**; paid **29 September 2025**.
- **GBP 109** total and paid; zero due and credited.
- No credit notes, prepayments or overpayments in the returned metadata.
- One GBP 109 payment; its reference is blank, so payment method is unproven.
- Tracking: **Projects = MEMBERSHIPS**.
- Description: **Full Membership Overseas (Paid £47)** (encoding repaired here for readability).

There is an earlier September 2025 paid GBP 47 Retired Membership invoice.
This creates a material possibility that GBP 109 is a class-upgrade balance,
not the whole term price. No older invoice will be linked by this backfill.
The user subsequently confirmed **GBP 109** as the historical amount to show.
Do not sum the older invoice or present it as the linked latest invoice.

## Proposed interpretation and unresolved mapping

“Last membership payment invoice” means the latest genuinely paid membership
invoice, excluding non-membership invoices, drafts, voids/deletions and unpaid
renewals. The user explicitly approved this interpretation.

The user confirmed GBP 109 and expiry 29 September 2026, and instructed that
membership establishment should treat the cohort as paid, with manual
adjustment of unpaid cases later. Record this as **operator-attested paid
membership**, not provider-verified settlement or an inferred bank/card method.
Known DD evidence remains an exclusion. No unpaid Xero invoice should be
relabeled as paid at the provider or linked as a verified paid invoice.

The operator clarified that these are existing **2025/2026** memberships, not
future memberships. Commencement remains null: no annual start is inferred.
The legacy type is retained as the displayed tier, without attaching today's
pricing structure or creating a renewal, commitment or agreement.

The pilot invoice PDF was retrieved through the existing server-side Xero
helper: 58,265 bytes, valid `%PDF-` header, SHA-256
`42c4fb9d588de39821bedf5bbacd28f1484b698725e8a385a821097596f15ed0`.
This is a provider/helper check, not an authenticated deployed browser test.

## Preliminary cohort inventory

Read-only, repeatable-read DEST inventory of 3,865 BNMS members:

| Category | Count |
|---|---:|
| Requires term and invoice review | 453 |
| DD evidence excluded | 414 |
| Existing history excluded (after DD exclusions) | 56 |
| Outside active supported legacy membership types | 2,918 |
| Missing or invalid expiry | 24 |

The 453 candidates comprise 191 Full UK, 78 Trainee UK, 46 Student,
27 Associate UK, 77 Junior UK, 22 Full Overseas, 7 Associate Overseas and
5 Junior Overseas. These are **not** 453 ready or approved inserts.

Source snapshot digest:
`2ebff20d2862dac39a652b25d540a08602349ed2bcb1e5d14a9546b521f70d64`.
The read-only inventory is reproducible with
`node scripts/audit-bnms-non-dd-cohort.mjs`.
Four offline test groups passed for source-date parsing, DD exclusion,
review-only classification, existing-history conflicts and missing evidence.

## Outcome and migration status

- Pilot: **applied** in DEST, history ID
  `0ff50f40-15b1-567f-a4d1-c353d9342fae`. Active, paid, upfront,
  2025/2026; expiry 2026-09-29; start unknown; GBP 109; the single reviewed
  invoice linked through both canonical and legacy accounting columns.
- Membership writes committed: **83 inserts, 0 updates, 0 deletes**.
  An initial transaction rolled back when PostgreSQL returned a Date object
  rather than the manifest date string; normalization was fixed before success.
- Exact pilot replay: **0 writes**, before/after count **1/1**.
- Exact cohort replay: **0 writes**, before/after count **82/82**.
- Post-apply DEST reconciliation: **83 active/paid records**, **1 linked invoice**,
  **82 unknown amounts/unlinked invoices**, **0 populated starts, term keys,
  billing agreements, commitment snapshots or renewal dates**.
- Roles, joining dates, billing plans and notifications: unchanged.
- **No schema migration was needed. None were created or applied to DEST;
  none remain outstanding. SOURCE schema/data were not changed.**
  Existing tenant/member/year uniqueness, deterministic IDs, serializable
  transactions, checked table locks and row provenance support this bounded import.
- Rollback evidence: private manifest `/tmp/bnms-non-dd-pilot-approved-v2.json`,
  durable pre-commit/full-row journal
  `/tmp/bnms-non-dd-pilot-applied-checked.json`, and replay result
  `/tmp/bnms-non-dd-pilot-replay.json`.
  Manifest SHA-256:
  `d592e9c43331504a80d58bf320586406ab7fe725d6037ce0792cc6a3fbb6764b`.
  Rollback requires this manifest/hash and exact unchanged full saved rows,
  and refuses known downstream adoption references. It was tested with
  fixture data, not committed against the live pilot.

## Approved current cohort and remaining invoice exceptions

The original 453 candidates split into 83 with current expiry between
2026-09-22 and 2026-12-31, 92 already expired and 278 with later expiries.
The latter two groups are excluded rather than inferred to be current 2025/2026.
After applying the pilot, **82** current candidates remained; all 82 are now applied.

A completed read-only Xero review found:

| Unresolved invoice evidence | Count |
|---|---:|
| Exact email + retained YM account identity missing or ambiguous | 52 |
| Latest paid membership invoice lacks a confirmed 2025/2026 term | 27 |
| Latest paid invoice period conflicts | 2 |
| Multiple paid membership invoices with the same latest date | 1 |
| Safe additional invoice links ready | **0** |

No older invoices were retained or linked to these members. Provider failures
were not classified as missing evidence; the first rate-limited attempt stopped
without writes, and the completed review used bounded Retry-After handling.

The user explicitly selected **“Apply the 82 current memberships”** after
reviewing the missing invoice/amount consequences. The approved manifest
established these existing memberships under the operator's paid assumption
while leaving historical amounts and invoice links **unknown**, not zero or
fabricated. Each row records its invoice exception.

- Private review: `/tmp/bnms-non-dd-cohort-current-review.json`.
- Approved attested manifest: `/tmp/bnms-non-dd-attested-cohort-review.json`.
- Transactional dry run: `/tmp/bnms-non-dd-attested-cohort-dry-run.json`;
  **0 writes**, **82 proposed**.
- Applied full-row journal: `/tmp/bnms-non-dd-attested-cohort-applied.json`;
  **82 inserts**, committed.
- Exact replay: `/tmp/bnms-non-dd-attested-cohort-replay.json`; **0 writes**.
- The same guarded rollback procedure applies to the cohort, using its own
  approved manifest/hash and saved full-row journal. No rollback was executed.
- Manifest SHA-256:
  `952272e9156fb9b0aa16a595567ed24ba4a1c90f189f26c971e3c0142b765a3e`.

## Verification boundaries

- 95 focused offline tests passed for history, current membership, invoice
  ownership/tenant access, source classification, matching and importer behavior.
  The later attested-manifest/importer test batch passed 22 tests (overlapping
  those 95, plus 3 new attestation checks).
- 29 existing History browser tests passed with intercepted fixture API data,
  including permission-gated PDF preview/download and error states.
- A DEST-backed membership handler check with fixture admin identity returned
  the pilot as `legacyCurrentMembership`, with £109, unknown start and retained
  expiry, no current commitment and no next-year preview. Live pricing remains
  separate and does not manufacture membership evidence.
- The existing permission-checked invoice route, backed by DEST and the real
  Xero provider but fixture admin authentication, returned a valid PDF:
  58,265 bytes, inline filename `membership-invoice-300004629.pdf`, private/no-store,
  SHA-256 `ce741f3525b70408c8e64020aa01424f4fc675194754c8f3dd44449d7ad9aabc`.
  Generated PDF bytes may differ from the earlier helper retrieval.
- No authenticated deployed UI verification has been performed. The ordinary
  workspace preview reports “Tenant not found” against its legacy connection;
  it is not evidence about the verified DEST records or deployed BNMS UI.
- Workspace UI changes still need normal release/merge before they can be
  claimed live on BNMS's published site.

Reproduce this bounded read-only audit with
`node scripts/audit-bnms-non-dd-pilot.mjs`. It has no apply mode and rejects flags.
It requires an already-fresh tenant Xero connection; provider errors stop the audit.