# Annual Membership Value Widget

**Author:** Replit Agent
**Last Updated:** September 2026
**Module:** Dashboard reporting

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Valuation and allocation](#valuation-and-allocation)
4. [Configuration](#configuration)
5. [Entry points and safeguards](#entry-points-and-safeguards)
6. [Database and deployment](#database-and-deployment)
7. [Verification and troubleshooting](#verification-and-troubleshooting)

## Overview

Annual Membership Value is a stat-only dashboard source for recorded organisation membership value excluding VAT. It is not cash received, accounting revenue, or a settlement report. Payments, refunds and credit notes are not reconciled.

We sum saved membership prices rather than recomputing fees. Classification is selected from the tenant's organisation fields; the system never guesses which option means HE. Individual memberships are outside this source.

## Architecture

| File | Purpose |
|---|---|
| `api/dashboard/_lib/organisationMembershipValue.js` | Eligibility, catalog, complete reads, decimal sum and warnings |
| `api/dashboard/_lib/sources.js` | Authorized catalog integration |
| `api/dashboard/_lib/aggregation.js` | Dedicated aggregation dispatch |
| `api/dashboard/_lib/validation.js` | Source and stat-only save validation |
| `api/dashboard/_lib/permissions.js` | Existing financial report permission boundary |
| `api/dashboard/_lib/resultCache.js` | Saved configuration cache identity |
| `api/dashboard/widgets/preview.js` | Preview authorization and execution |
| `api/dashboard/widgets/[id]/data.js` | Saved and cached result access |
| `client/src/components/dashboard/WidgetBuilderModal.jsx` | Builder controls and persistence |
| `client/src/components/dashboard/WidgetCard.jsx` | Currency value, period, warnings and CSV |
| `shared/widgetDescriber.js` | Source-specific helper description |

## Valuation and allocation

Durable history states `active`, `scheduled`, and `expired` qualify independently of payment status. Record-fee and renewal writers persist active/scheduled commitments before or independently of payment. Conversely, monthly card/DD setup writes `pending_payment_setup` before commitment completion. It must not be counted merely because a row exists.

Cancelled, void, superseded, draft and checkout-setup records are excluded. Unrecognised or missing lifecycle states are disclosed instead of assumed final. Simulations and quotes do not contribute.

```text
periodStart = first day of selected month in selected year
periodEndExclusive = first day of same month in following year
for each qualifying history record once:
  resolve retained commitment_snapshot.config
  otherwise resolve tenant-scoped history.config_id
  require periodStart <= applied effective_from < periodEndExclusive
  apply structure/band and organisation classification selections
  add saved final_cost, without recalculating discounts or VAT
```

August 2026 therefore means 2026-08-01 through 2027-07-31 inclusive. Payment, invoice, joining, creation and membership-term dates do not allocate records. January, December and leap years use calendar boundaries, not a fixed day count.

Snapshots take precedence over current config contents. A partial snapshot can borrow a missing date/currency only when its ID and the history config ID identify the same tenant-verified structure. No fallback selects today's active structure. Missing evidence produces counted warnings.

The saved `final_cost` already reflects recorded discounts and approved add-ons and excludes VAT. Zero is valid; null or invalid amounts are not zero. Decimal accumulation uses integer arithmetic and retains an exact decimal string. Multiple currencies require an explicit currency selection; no foreign-exchange conversion occurs.

Classification uses current organisation preference values, not a claimed historical classification snapshot. Multiple matching preference rows cannot multiply membership amounts.

## Configuration

```json
{
  "source": "organisation_membership",
  "measure": {"aggregator": "sum", "fieldKind": "system", "field": "final_cost"},
  "membershipValue": {
    "startMonth": 8,
    "startYear": 2026,
    "currency": "GBP",
    "configIds": [],
    "bandIds": []
  },
  "filters": []
}
```

| Setting | Meaning |
|---|---|
| `startMonth`, `startYear` | Required explicit annual period |
| `currency` | Optional single currency; mixed sums otherwise rejected |
| `configIds`, `bandIds` | Optional tenant-owned structure/tier restrictions |
| `filters` | Organisation custom-field comparisons, combined with AND |

The builder uses tenant catalog options for structures, bands, currencies and classification fields. Generic measure, time bucket, charts and CRM click-through controls are unavailable. Editing retains the source options. Preview and saved cards show the exact period and allocation basis, net VAT semantics and warnings.

## Entry points and safeguards

```text
Catalog → financial authorization → tenant options → builder
Preview → financial authorization → validation → dedicated engine
Save/edit → ownership + financial authorization → stat/config validation
Saved data/refresh → ownership + financial authorization → config-keyed cache/engine
```

Dashboard permission alone is insufficient. The source follows the existing Membership Payment Report financial-data boundary. Catalog, list, preview, individual access, mutation and cached-data endpoints enforce it. Drilldown is rejected instead of treating history IDs as organisation CRM IDs.

Reads use stable ordering and exact-count pagination, continuing even when a provider returns fewer rows than requested. Errors, missing pages, changed counts and scan limits fail explicitly. Preference lookups use bounded organisation-ID batches and a cumulative limit. A complete empty result is zero; a zero with unresolved evidence renders unavailable. Partial nonzero results retain warnings.

Cache identity includes the full configuration, so period, currency and filter edits cannot reuse the previous configuration's result.

## Database and deployment

Existing persistence is sufficient:

| Table | Data used |
|---|---|
| `organisation_membership_history` | Lifecycle, organisation/config/band IDs, saved amount/currency and commitment snapshot |
| `membership_tier_config` | Referenced historical structure and effective dates |
| `membership_tier_band` | Tenant-owned band choices |
| `preference_field` | Organisation classification definitions/options |
| `organization_preference_value` | Current classification values, tenant-scoped through organisation |
| Existing dashboard widget/cache tables | Saved configuration and cached results |

**No migration is needed or applied. No database is modified by deployment of this feature.** No tenant dashboard is automatically configured, and no billing or membership lifecycle writer changes.

## Verification and troubleshooting

Core cases are in `api/dashboard/_lib/organisationMembershipValue.test.mjs`; endpoint/cache contracts are in `membershipValueWiring.test.mjs` and the dashboard widget suites. Mounted card/builder cases are in `WidgetCard.test.jsx`. The isolated Playwright config is `tests/task-4771-annual-membership-value.config.mjs`.

Browser fixtures intercept all data and do not prove production data quality or deployed authorization. They do verify real builder save/reopen and card rendering.

- **Unavailable or warning:** inspect the counted evidence category; do not fill missing prices/dates from current pricing.
- **Multiple currencies:** choose one of the tenant currencies.
- **Source absent:** verify financial report permission as well as dashboard access.
- **Unexpected historical allocation:** inspect the applied structure's effective date; membership-year text is intentionally not used.
- **Scan limit or retrieval failure:** the widget refuses an incomplete answer; investigate dataset size/provider error rather than treating it as zero.