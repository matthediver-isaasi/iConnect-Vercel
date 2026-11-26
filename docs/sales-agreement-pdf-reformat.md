# Reformatting retained signed sales-agreement PDFs

Quote/proposal PDFs are rendered from stored snapshots every time they are
downloaded, previewed or sent, so they always use the current layout. Fully
signed agreements are different: their final PDF is retained in the private
`sales-agreements` bucket and checked against `final_pdf_hash` on every
download. To give them the new layout (`proposal-layout-v2`), run the backfill.

## What it does

For each `sales_agreement_envelope` with `finalization_status = 'complete'`:

1. Skips the agreement if its active file is already the current layout path
   (`<tenant>/<envelope>/final-proposal-layout-v2.pdf`).
2. Confirms the current file still passes the download integrity check.
3. Renders a new PDF from the stored signed snapshot, signatures and document
   hash (nothing in the envelope is changed). The upload uses `upsert: false`;
   a file left by an interrupted run is reused, never overwritten.
4. Calls `supersede_sales_agreement_final_pdf`, which locks the row, inserts a
   `sales_agreement_final_pdf_history` record (original path, original SHA-256,
   original finalized time, replacement path/hash, layout, time) and switches
   `final_pdf_path`/`final_pdf_hash` in one transaction. The guard trigger
   refuses any other change to a completed agreement.
5. Re-checks the new active file with the normal download integrity check.

Failures leave the original file active. Originals are never deleted, so the
signed PDF as first issued can be produced from the history table if needed.

## Prerequisite

Apply `supabase/migrations/202702040001_sales_agreement_final_pdf_history.sql`
(owner approval required for the production database). The migration fails
closed if the installed guard is not the reviewed definition.

## Running

```
# Dry run (default): lists what would change, writes nothing
node scripts/reformat-signed-sales-agreements.mjs --target dest

# Optional scope
node scripts/reformat-signed-sales-agreements.mjs --target dest --tenant <tenant-uuid> --limit 5

# Apply
node scripts/reformat-signed-sales-agreements.mjs --target dest --apply
```

`--target dest` uses `DEST_SUPABASE_URL`/`DEST_SUPABASE_KEY` and refuses any
host other than the pinned production project. `--target runtime` uses
`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`. Each agreement prints one JSON line,
then a summary of counts; the exit code is non-zero if any agreement failed.
Rerunning is safe: reformatted agreements are skipped.

When the layout constant `SALES_QUOTE_PDF_LAYOUT` is bumped in future, the same
script reformats agreements again to the new layout path, adding another
history row.
