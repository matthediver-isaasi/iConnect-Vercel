# Audited cart display amendments

The owner approved a display correction for one BNMS submission after manually
adjusting its Xero invoice and catalogue stock. Those external/accounting and
stock changes must not be repeated.

## Applied correction

- Destination: `lvmzliemqnieeoruhkik`, 2026-11-19.
- Submission: `c9537c37-2278-4dc9-b8ad-31bab1e895a7`.
- Display: Silver Sponsor - Stand 48 → Silver Sponsor - Stand 49.
- Migration: `202701220002_form_cart_display_amendments.sql`.
- Reviewed SHA-256: `ab1fa17f817cbaf4b810d1a16d8b4d44a7f8f2bd61c9f114d6a8bea07df91542`.
- Runner: `scripts/correct-bnms-stand-display.mjs --apply`.

The exact-target runner rehearsed the migration and correction in a rolled-back
transaction, then applied it. Independent readback confirmed one amendment and
the corrected display. No Xero calls, messages, payments or stock writes ran.
Stock rows, the accounting queue row and original receipt were compared in full
and preserved. Other submission fields were preserved except generic update
timestamps and the explicitly corrected display receipt.

## Authority boundaries

Original `form_cart_receipt` terms and answers, original submitted selection,
and invoice snapshots remain purchase evidence. Do not rewrite these to match
the later correction or rerun allocation, invoice creation or finalization.

The service-read-only `form_cart_display_amendment` table records original and
replacement item IDs/names, reason, approval provenance and timestamp. It has no
browser or service-role write grant. A final BEFORE UPDATE trigger projects
approved amendments into `submission_data.__cart_receipt`, after the original
immutability guards have validated the update. Subsequent ordinary updates
cannot revert the display or bypass protection of financial terms.

Existing submission views and receipt-based CSV/Word exports use this projected
receipt. Raw original selection IDs intentionally remain historical evidence.
No frontend deployment is required for this correction.

Only an explicitly authorized operator may add a further amendment. The supplied
runner is pinned to this single correction, not a general editing interface.
