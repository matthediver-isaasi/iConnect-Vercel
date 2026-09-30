# Repair GFI Xero membership references

This one-off command changes only unpaid Graduate Futures Institute Xero
invoices whose Reference is exactly `Membership <year>` (for example,
`Membership 2025/2026`). It proposes and applies the value `TBC`. It does not
write to application membership records.

## 1. Generate the dry-run manifest

With the production destination environment configured:

```sh
node scripts/repair-gfi-xero-membership-references.mjs
```

Dry-run is the default; there is no dry-run flag to forget. The command resolves
the exact `gfi` tenant, reads its existing Xero connection, paginates all Xero
invoices, and creates:

`scripts/output/gfi-xero-reference-dry-run-<timestamp>.json`

It performs no Xero invoice updates and no application-database writes. It also
refuses to refresh an expired/near-expiry token in dry-run mode; refresh the
connection separately and rerun. The manifest is signed using `SESSION_SECRET`
so apply mode rejects edited or forged selections.

## 2. Review and approve

Cross-reference the manifest's `target`, `summary`, `selected`, and `skipped`
sections. Each selected row includes the Xero invoice ID and number, status,
balance, contact, dates, original/proposed reference, and linked local
membership-history rows. Confirm every selected invoice is intended for repair.

Keep this exact file: apply mode does not rediscover or broaden the selection.

## 3. Apply only the approved manifest

```sh
node scripts/repair-gfi-xero-membership-references.mjs \
  --apply \
  --manifest=scripts/output/gfi-xero-reference-dry-run-<timestamp>.json
```

Both `--apply` and an explicit manifest path are required. The script validates
the GFI application tenant and current Xero organisation against the manifest.
Before each update it re-fetches the invoice and requires the same ID, number,
status, positive balance, and exact original reference recorded at review time.
Changed, paid, voided, deleted, already-correct, unrelated, or genuine-PO
invoices are skipped rather than overwritten.

Do not edit the manifest: any edit invalidates its signature. Generate a fresh
dry run instead.

## 4. Cross-reference the result

Apply creates a separate, non-overwriting report:

`scripts/output/gfi-xero-reference-apply-result-<timestamp>.json`

The result is created in `in-progress` state before the first update and is
atomically checkpointed with an `updating` write-ahead entry before every Xero
POST, then again after verification. A failed write-ahead checkpoint prevents
the update. If interrupted after the POST, the durable `updating` entry marks
the invoice for manual Xero re-read and reconciliation; do not blindly rerun
that invoice. For every reviewed invoice it records the recheck, skip/error
reason or Xero response, and the final re-read Reference. Compare invoice IDs/numbers against
the approved manifest and require `summary.errors` to be zero. The process exits
non-zero if any attempted update cannot be verified as exactly `TBC`; retain
both files for the audit trail.