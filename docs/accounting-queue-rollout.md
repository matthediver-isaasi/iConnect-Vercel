# Accounting queue rollout boundaries

## Implemented preparation coverage

The following sources persist their original request before provider customer
lookups. Preparation uses the same fenced, company-bound transport and shared
rate-limit cooldown as GoCardless:

- `member_membership_history`: eligible unpaid, standalone membership invoices.
- `organisation_membership_history`: eligible unpaid, standalone membership invoices.
- `sales_commercial_sale`: accepted commercial-sale invoices.

Membership preparation freezes invoice inputs, relevant accounting settings,
invoice date and due date. Commercial sales freeze accepted line economics,
tax/account mappings, the original claim key and customer selection.

Existing accepted queue requests retain ownership when source switches are disabled.
Preparation cannot write invoices or payments. Unknown financial outcomes still
require discovery, not another creation request.

No new migration is required. These changes use the existing queue and durable
preparation migrations (`202612050001` and `202612050002`).

## Do not treat this as universal accounting recovery

Keep production's existing `gocardless_payment` setting until rollout is reviewed.
The new preparation coverage does not itself implement:

- Membership notification continuation after asynchronous invoice completion.
  Existing pending responses explicitly state that no invoice email was sent.
- Paid/Stripe-settled memberships, form settlement, instalments or membership
  add-ons. These retain their existing owners.
- Training-fund purchase adoption. Its request currently combines accounting,
  pending-balance updates and, for cards, Stripe setup. This needs idempotent
  continuation before `training_fund_purchase` can be admitted.
- QuickBooks event recovery through the existing Xero-specific event recovery
  mechanism.

Event invoice recovery remains separate from ACCOUNTING_REQUEST_QUEUE_SOURCES.
Its regression tests are not a live provider or production scheduler check.

No historical failures are automatically backfilled by enabling a source.
Recovery needs verification of original source authority and existing provider
documents before admitting old work.
