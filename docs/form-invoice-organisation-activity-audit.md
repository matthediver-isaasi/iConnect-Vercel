# Organisation purchase Activity: read-only audit

## Scope and result

Audited current production Supabase destination `lvmzliemqnieeoruhkik` on
26 November 2026. SOURCE and staging were not queried. This is an audit only:
**no additional live repair was performed or authorised.**

The initial all-tenant read at 09:29:42 UTC found:

| Check | Submissions |
| --- | ---: |
| Existing invoice-order submissions | 11 |
| Missing `organization_id` | 10 |
| Containing a frozen `organizationCustomer.organizationId` | 1 |
| Missing `organization_id` with a frozen organisation ID | **0** |
| Accounting invoice queue rows | 11 |
| Queue rows without a same-tenant submission | 0 |
| Invoice-provider submissions outside order/queue authority | 0 |

All 11 belong to BNMS's **Spring Meeting Exhibitor Booking** form. Bayer is
the sole submission with a frozen organisation ID. Its existing association
matches the frozen ID and a same-tenant organisation row; it is already linked
and excluded from any additional repair.

The other 10 have no frozen organisation ID. They cannot be associated using
this task's trusted-ID rule. This does **not** establish that they are individual
purchases or identify which organisation should own them. Names, billing text,
form answers and member affiliations were not used to infer associations.

## Why they are absent from organisation Activity

`client/src/components/OrganisationDetailView.jsx` fetches form submissions by
the persisted `organization_id` when the Forms or Activity tab is active.
Activity combines the 10 newest fetched form submissions with bookings and
shows at most 15 combined entries. A null organisation link excludes the
submission from this query; invoice creation alone does not associate it.

`api/_lib/formInvoiceOrder.js`:

- `prepareFormInvoiceOrder` stores the server-prepared customer snapshot.
- `assertFormInvoiceSource` verifies source/provider/form/amount/currency and
  exact queue-to-submission snapshot equality.
- `linkFormInvoiceSource` already supports linking a missing organisation from
  that frozen ID after a same-tenant lookup, rejects conflicting links and
  fences concurrent changes. It does not reconstruct missing historical IDs.

`api/_lib/formInvoiceOrganization.js` verifies the selected organisation against
the tenant when freezing the customer. This audit does not repeat provider
contact discovery or treat the snapshot's name-match policy as permission to
match legacy purchases by name.

## Evidence and repeatability

`scripts/sql/audit-form-invoice-organisation-activity.sql` is a single SELECT
with no write or provider-call path. It scans all tenants without a row limit,
includes invoice-provider records, invoice-order metadata and queued invoice
orders, aggregates queue joins to avoid duplicate submission counts, and emits
counts plus record IDs and classifications. It deliberately omits answers,
personal contact details, addresses and invoice contents.

The report's downloadable companion contains the complete 11-record scope.
Its candidate rule requires a missing link, a same-tenant UUID, version-1 source
and customer authority, matching form/amount/currency, one matching accounting
queue snapshot and provider binding, and a structurally valid saved contact ID.
A verified existing link is reported separately, never as a candidate.
Provider settlement is not inferred: all source rows were `unpaid`, and the
accounting queue's payment-processing status was `skipped`.

The 11 queue snapshots exactly matched their stored invoice-order snapshots.
No form answers or snapshots were edited or replayed, and no invoice, payment,
email, notification, workflow or accounting recovery was triggered.

The saved audit query was executed successfully at **09:31:16 UTC** on the same
date and returned exactly 11 records: **0 candidates, 1 already linked,
10 excluded because no frozen organisation ID exists**. Its full result was
parsed and checked against those counts before generating the companion report.

The existing isolated invoice-order and organisation-customer unit suites
passed **22/22 tests**:

```sh
node scripts/run-isolated-tests.mjs node --test \
  api/_lib/formInvoiceOrder.test.mjs \
  api/_lib/formInvoiceOrganization.test.mjs
```

These tests use fixtures, not live writes or provider calls. They cover missing
and existing organisation links, conflicting links, cross-tenant rejection and
concurrent changes; they do not prove deployed UI behaviour.

## Boundaries and next action

**No repair approval is needed for this report because there are zero eligible
additional records.** Any later repair requires a fresh read and explicit
approval of an exact tenant/submission/organisation allowlist. Update only the
missing association with concurrency guards; preserve answers and invoice
snapshots, inspect trigger effects first, and verify the resulting Activity
query without replaying financial or notification processing.

Resolving the 10 excluded legacy submissions needs new authoritative purchaser
evidence and separately approved scope. The report does not authorise such
research or changes.

This task did not change application behaviour or deploy anything. Signed-in
Organisation Activity was not browser-verified; its filter and rendering were
inspected in code, and the underlying production associations were checked
read-only.
