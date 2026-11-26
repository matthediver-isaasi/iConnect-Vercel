# Converted totals and opportunity forecasts

## Approved behaviour

- The Opportunities table replaces **Value** with **Converted**: sum the net
  totals of confirmed commercial-sale proposal versions, excluding VAT.
- Add **Forecasted value**, using the opportunity's existing saved amount.
  Creation and the Overview details card use that same label.
- Future ordinary and ticket conversions preserve the forecast amount and its
  currency. They still create commercial receipts and perform normal won-stage
  and activity updates.
- Do not reconstruct historical forecasts or rewrite existing values, proposal
  snapshots, invoices, payments, dashboard/pipeline valuation rules or exports.

Unconverted alternatives do not contribute. Confirmed versions remain the
authority after amendment or archival. No conversions means zero; missing,
incompatible or unsafe net evidence means unavailable, not a partial total or
gross fallback. Reads retain tenant/visibility scope, batching and pagination.

## Database installation

Source: `supabase/migrations/202702050001_opportunity_forecast_values.sql`.
Installed on destination `lvmzliemqnieeoruhkik` as managed migration
`20261126135014_opportunity_forecast_values_preserved_on_conversion`.

The migration transforms only two checksum-pinned current function definitions.
It removes the opportunity amount/currency assignments, preserves the remainder
and refuses unreviewed predecessors. Already-patched definitions are a no-op.
Never replay earlier conversion migrations to apply this change.

The unmodified production migration first passed a real-schema rollback
rehearsal. Independent reads confirmed restoration of both original function
checksums. Installation then checked that every opportunity row was unchanged
inside a table-locked transaction. Final reads verified both new checksums and
unchanged service-only execution permissions. No production conversions or
provider actions were invoked.

## Verification and deployment boundary

38 focused checks passed, covering projections, API scoping/failures, UI label
and column wiring, and local PostgreSQL ordinary/ticket conversion and replay.
The partial synthetic PostgreSQL fixture binds the guarded transformation to
its own predecessor fingerprints; it is not proof of production identity.
The separate, unmodified live-schema rehearsal supplies that evidence.

Private machine-readable rollout evidence is retained in the ignored,
deployment-excluded `generated-artifacts/opportunity-values-rollout/` directory.
The database safeguard is installed; UI/API code follows the usual Vercel
deployment. The signed-in UI was not browser-verified because the development
preview has the existing tenant-resolution error.
