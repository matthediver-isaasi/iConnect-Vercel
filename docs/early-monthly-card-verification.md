# Early monthly card renewal: verification boundaries

## Provider contract

The installed Stripe SDK defaults to `2025-11-17.clover`. Its Checkout
SubscriptionData type supports `trial_end` (at least 48 hours in the future),
`billing_cycle_anchor`, `proration_behavior`, and required payment-method
collection.

Sources consulted:
- https://docs.stripe.com/payments/checkout/billing-cycle
- https://docs.stripe.com/payments/checkout/free-trials
- Installed Stripe Checkout Session request types and API version.

A successor more than three days away uses its midnight UTC start as the
trial end. The additional day allows the normal Checkout lifetime and the
existing bounded retry window without crossing Stripe's 48-hour minimum.
Shorter leads use a future billing anchor with prorations disabled. Stripe
documents that a Checkout completed after that anchor bills the full period
beginning at the anchor, not an earlier prorated period.

The trial is a provider billing mechanism, not a free membership entitlement.
The immutable consent records the first charge and successor end. The finite
Subscription Schedule preserves that first charge/trial boundary and cancels
before an additional instalment. Existing activation policy remains applicable.
Zero-value invoices follow the existing identity validation and zero-invoice
exclusion before instalment, settlement, and accounting effects.

## Isolated verification

186 tests passed across:
- api/membership/monthly-card-renewal.test.mjs
- api/_lib/stripeMonthlyCard.test.mjs
- api/_lib/stripeDeferredCardTerms.test.mjs
- api/_lib/reconcileMemberCardCheckout.test.mjs
- api/_lib/formMembershipRenewalContext.test.mjs
- api/_lib/stripeMembershipWebhookConfig.test.mjs
- api/_lib/renewalPaymentSwitch.test.mjs
- api/webhooks/stripe-membership.monthly-card.test.mjs
- client/src/lib/membershipPaymentReturn.test.mjs

The reported 09/10/2026 expiry and 10/10/2026–09/10/2027 successor are
fixtures only. No live member was inspected or altered.
`npm run build` passed (existing large-bundle warnings remain).

## Not verified

- No Stripe sandbox Checkout or test-clock advancement was executed. The
  workspace integration inventory has no connected Stripe sandbox; no tenant
  credential/account was selected or verified for this work. Tenant-owned
  integration credentials may exist, but their presence is not sandbox evidence.
- No provider proof of twelve real scheduled collections, failed first
  collection, or authentication-required recovery is claimed.
- The running local preview reached the return route but displayed
  “Tenant not found”; its database reports a missing tenant table. No
  authenticated renewal UI rendering was verified. Authentication was not bypassed.
- No deployment or production verification was performed.

Before rollout, use an explicitly selected test account and fixture member,
complete real Checkout, advance a test clock across the first and final charge
boundaries, and verify invoice amounts/counts and failed/authentication-required
recovery. Test both trial and short-lead anchor branches. Also confirm existing
Stripe membership webhook registrations include `invoice.payment_action_required`;
the application's registration event list now includes it.

## Database and rollout

No new database migration is needed: consent uses existing JSON metadata and
existing history/agreement/election fields. No migration was applied to DEST,
SOURCE, or any other database. SOURCE was not modified. Existing successor
election schema/rollout gates remain prerequisites and were not changed.
No live charge, subscription creation, member update, or rollout was performed.
