# Stripe membership invoice recovery investigation

**Scope:** read-only investigation against the DEST Supabase data, the
configured tenant Stripe account, and deployment metadata. No Stripe,
Supabase, deployment, or cron mutations were performed. Personal/member
contact and address data is omitted. Production-linked record IDs,
deployment IDs, repository names, and project identifiers are intentionally
not reproduced here; they remain available in the investigation conversation
if needed.

## Executive conclusion

The Stripe collection succeeded. The failed operation was the subsequent
per-instalment accounting invoice step, which could not obtain the immutable
Stripe billing-address snapshot.

### Observed failure in the pre-fix source

The source observed during the investigation had a local metadata namespace
mismatch:

- Stripe monthly-card checkout persistence wrote the address to
  `agreement.metadata.stripe_billing_address`.
- The per-instalment invoicing path resolved it from
  `agreement.metadata.card.billing_address`.
- For the investigated agreement, the first key existed and the nested
  `card.billing_address` key was absent.
- `stripeInvoiceAddressFromSnapshot()` therefore raised
  `Stripe billing address snapshot is missing`.

### Current implementation status

The resolver fix is now implemented in the workspace source, but this report
does not establish that it has been deployed. The fixed resolver:

- treats the existing top-level `metadata.stripe_billing_address` as the
  canonical immutable snapshot;
- supports the older `metadata.card.billing_address` shape only when the
  canonical key is absent;
- fails closed if a present canonical snapshot is malformed, rather than
  falling back to another value; and
- reuses the existing original snapshot. It does **not** require or suggest
  backfilling a nested snapshot or mutating the agreement metadata.

The guarded reconciliation route was not invoked. A route run is not a
read-only or single-record action: it can write accounting-provider invoices
and local ledger state for other matching rows. Idempotency reduces duplicate
creation risk for an individual row, but does not remove the need for
separate approval before deployment or before cron/recovery execution.

## Membership and agreement state

The investigated records resolve to an active member, its owning tenant, and
its organization. The membership history is active with payment status
`partial` for membership year `2026/2027`. The related Stripe billing
agreement is `active`.

The membership history has no `paid_at` timestamp. The agreement has Stripe
subscription and Checkout-session references. Its immutable card terms are:

- 12 instalments;
- **£5.08** (508 minor currency units) per instalment;
- **£60.96** (6,096 minor currency units) total;
- first-payment activation;
- seven-day grace period; and
- `per_instalment` invoicing.

The agreement metadata contains a top-level
`stripe_billing_address` snapshot. The immutable card terms do not contain
`card.billing_address`.

## Plan, ledger, and provider evidence

The Stripe payment plan is `active`. It records 12 instalments, with one
counted as paid, a last-payment reference, and no completion, arrears, or
attention flag.

The corresponding accounting ledger row records:

- provider: Stripe;
- amount: **£5.08** (508 minor currency units);
- an external Stripe invoice reference matching the plan's last-payment
  reference;
- `accounting_sync_status`: `failed`;
- error: `Stripe billing address snapshot is missing`; and
- no accounting invoice created or linked.

A read-only lookup using the configured mode-tolerant Stripe credentials found
the referenced invoice in **test mode**. The tenant's membership Stripe mode
is `test`; the live-mode lookup returned `resource_missing`:

- invoice status: `paid`;
- amount paid: 508 minor units (£5.08);
- currency: GBP;
- `status_transitions.paid_at` is populated;
- collection method: `charge_automatically`;
- billing reason: `subscription_create`; and
- amount/currency match the DEST ledger row.

This confirms that the provider-side collection was successful and that the
failure occurred while posting the local accounting invoice, not while
collecting the Stripe instalment.

## Guarded retry route

The existing route is `/api/cron/reconcile-stripe-card-plans`.

Its safeguards and behavior are:

1. It fails closed with HTTP 503 when `CRON_SECRET` is not configured.
2. It requires an exact `Authorization: Bearer <CRON_SECRET>` header and
   returns HTTP 401 for an invalid header.
3. It runs several reconciliation sweeps. The instalment retry sweep selects
   failed/pending/unpaid rows and stale posting claims across the available
   data, rather than accepting a member, agreement, or ledger ID.
4. For every selected row, it reloads the owning billing agreement and calls
   `postStripeInstalmentInvoice(..., { reclaimStale: true })`.
5. Existing provider invoice linkage is reused, and deterministic provider
   idempotency keys plus the ledger claim state prevent duplicate invoice
   creation.
6. It records a scheduled-task result and reports a heartbeat when the
   relevant monitoring setting is configured.

For this row, the route would not collect Stripe again. It would retry the
accounting obligation using the fixed resolver in the current workspace
source. That intended behavior has not been exercised against DEST. A route
execution could also reconcile other tenants' matching rows and write
accounting data; it is therefore not a scoped recovery action for this
member. No retry was sent during this investigation.

## Automatic-cron and deployment caveats

`vercel.json` configures:

```text
/api/cron/reconcile-stripe-card-plans    25 */6 * * *
```

The schedule is only effective in the deployed revision that contains both
the route and the cron configuration. Source presence in the workspace does
not prove that production is running that revision. The production
environment must also have `CRON_SECRET`; otherwise the route intentionally
returns 503. If a deployment activates this schedule, automatic invocations
may begin broad reconciliation and accounting writes without a member-specific
filter.

Read-only deployment metadata showed a READY production deployment and a
separate READY preview deployment. The production revision is older than the
newer Stripe reconciliation source lineage. The route exists in older
production history, but the later fail-closed guard and reconciliation
behavior are in newer source lineage. The current resolver fix is a workspace
implementation and was not established by either observed deployment result.
A preview revision is not evidence that production has the fixed resolver or
the same backend behavior.

No user-facing page URL was supplied or verified. The deployment evidence
identifies project-level revisions only; it does not confirm a particular
member page, page URL, browser bundle, or what a user sees. No live page
request was made.

## Conditional recovery plan (not authorization)

Recovery requires two separate approval gates:

1. **Deployment approval:** explicitly approve deploying the fixed resolver
   and identify the intended production revision. This approval must account
   for the possibility that deploying active `vercel.json` cron configuration
   will allow automatic broad reconciliation.
2. **Cron/recovery approval:** separately and explicitly approve enabling,
   waiting for, or manually invoking `/api/cron/reconcile-stripe-card-plans`.
   This is a broad write-capable route, not a single-record-safe action, so
   the approval must cover possible accounting writes for other matching rows.

Neither approval is granted by this report, and neither deployment nor cron
execution was performed. A possible post-approval verification would be
read-only: re-read the target ledger and provider linkage, while checking
for unrelated rows changed by the broad sweep. For the target row, success
would mean the ledger leaves `failed`, links the accounting invoice, and
preserves the existing Stripe invoice reference.
