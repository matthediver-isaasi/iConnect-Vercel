## Monthly post-grace collection

For new monthly plans, `monthly_post_grace_collection_policy` is snapshotted in
the accepted agreement. `stop_collecting` stops later automated collections
after grace and leaves the period balance for manual recovery.
`continue_catch_up` records each missed due period once and requires the next
eligible collection to include unpaid periods plus the current instalment.
This is deliberately separate from `dd_arrears_policy`, which controls access
and escalation only; it does not change GoCardless's in-grace retry timing.
# GoCardless Membership Lifecycle

**Author:** isaasi  
**Last Updated:** September 2026  
**Module:** Membership Payments / GoCardless Direct Debit

---

## Table of Contents

1. [Overview and Executive Answer](#overview-and-executive-answer)
2. [Architecture](#architecture)
3. [Terms, Offers, and Immutable Agreement Snapshots](#terms-offers-and-immutable-agreement-snapshots)
4. [Individual Join Lifecycle](#individual-join-lifecycle)
5. [Organisation Join Lifecycle](#organisation-join-lifecycle)
6. [Mandate Creation, Discovery, and Reuse](#mandate-creation-discovery-and-reuse)
7. [Subscription Creation and Membership Activation](#subscription-creation-and-membership-activation)
8. [Invoice Timing and Accounting](#invoice-timing-and-accounting)
9. [Confirmed Payments, Completion, and Payouts](#confirmed-payments-completion-and-payouts)
10. [Renewal Lifecycle](#renewal-lifecycle)
11. [Failure, Retry, Cancellation, Chargeback, Refund, and Arrears](#failure-retry-cancellation-chargeback-refund-and-arrears)
12. [Webhook Durability and Tenant Routing](#webhook-durability-and-tenant-routing)
13. [Scheduled Jobs](#scheduled-jobs)
14. [Emails](#emails)
15. [Code Paths and Entry Points](#code-paths-and-entry-points)
16. [Safeguards and Error Handling](#safeguards-and-error-handling)
17. [Frontend UI and Administration](#frontend-ui-and-administration)
18. [Database Tables](#database-tables)
19. [Data Flow Diagrams](#data-flow-diagrams)
20. [External Integrations](#external-integrations)
21. [Configuration Reference](#configuration-reference)
22. [Deployment Readiness Audit](#deployment-readiness-audit)
23. [No-Mutation Verification Checklist](#no-mutation-verification-checklist)
24. [Representative Sandbox Go-Live Scenarios](#representative-sandbox-go-live-scenarios)
25. [Troubleshooting](#troubleshooting)

---

## Overview and Executive Answer

The GoCardless membership subsystem lets an individual member, or an organisation through its primary or billing contact, pay a membership-year commitment in one to twelve monthly Direct Debit instalments. A checkout creates a local **billing agreement** and membership-history row, GoCardless creates or supplies the mandate, the application creates a fixed-count subscription, and signed webhooks advance the agreement, plan, payment, membership, accounting, and communication state. The core design is an event-driven state machine backed by durable mirrors and immutable consent terms. The principal implementation is in `api/membership/direct-debit.js` (`handlePost()`), `api/membership/org-direct-debit.js` (`handleStart()`), `api/_lib/gocardlessDirectDebit.js`, and `api/_lib/gocardlessWebhookProcessor.js` (`processGocardlessEvent()`).

**Executive answer:** the source contains a broad, coherent lifecycle implementation: individual and organisation setup, new and reused mandates, fixed-count subscriptions, configurable activation, payment and payout mirrors, per-instalment Xero/QuickBooks posting, arrears, member/admin recovery, cancellations, refunds, notices, and individual renewal. It is **not proven ready for production money movement by the evidence available to this audit**. The read-only DEST evidence proves that the expected schema and some configuration are present, but there are no GoCardless customers, mandates, agreements, plans, or payments with which to prove an end-to-end lifecycle. In addition, the audit found material operational or design gaps: failed webhook rows are acknowledged but are not generically replayed; annual-mode payment application has no automatic retry; annual invoice creation failures in the membership renewal cron are non-fatal; a DD-created annual-mode history row is not itself guaranteed an annual invoice; organisation DD renewal is not handled by the DD renewal engine; cron authentication is fail-open when `CRON_SECRET` is absent; and finite cron limits plus 60-second function duration require volume proof.

**Deployment conclusion:** keep live collections **blocked** until credentials, environment, webhook callback registration/routing, dedicated GoCardless accounting bank accounts, scheduler delivery, and the representative sandbox scenarios in this guide are proved. No secret, tenant identity, account identifier, payer data, or bank details are reproduced here.

### Explicit Join Timeline

| Time | Event | Durable effect | Source |
|------|-------|----------------|--------|
| T0 | Member selects monthly DD | Simulation resolves current year and tier offer | `direct-debit.js` `handlePost()` lines 130–159; `org-direct-debit.js` `handleStart()` lines 207–244 |
| T0 | Consent is accepted | New agreement stores `metadata.dd`; history row is `pending_payment_setup` / `unpaid` | `gocardlessDirectDebit.js` `buildAgreementSnapshot()` lines 120–150; join endpoints lines 197–299 / 279–391 |
| T0 | Active mandate exists | Agreement reuses mandate; subscription is created immediately | `findReusableMandate()` lines 374–397; join endpoints lines 307–321 / 419–431 |
| T0 | No active mandate | Billing Request + hosted flow is created; payer completes GoCardless UI | individual lines 219–244; organisation self lines 312–335; billing-contact flow is deferred until invite acceptance |
| T1 | Billing request fulfilled | Customer/mandate mirrors are upserted and agreement becomes `mandate_pending` | `gocardlessWebhookProcessor.js` `processBillingRequestEvent()` lines 141–224 |
| T2 | Mandate active | Plan and fixed-count subscription are created; activation rule is evaluated | `processMandateEvent()` lines 305–422; `ensureSubscriptionForAgreement()` lines 184–304 |
| T3 | First payment confirmed | Plan/agreement become active, membership may activate, payment becomes partial, accounting posting is attempted | `processPaymentEvent()` lines 516–680 |
| T4... | Later payments | Each payment is mirrored; accounting and confirmation email run on `confirmed` | same function, especially lines 574–661 |
| Tend | Subscription `finished` | Plan becomes `expired`, `completed_at` is set, history is `paid`, completion email is sent | `processSubscriptionEvent()` lines 472–502 |

The dates between T0 and T3 are controlled by GoCardless mandate timing and the snapshotted first-collection rule; they are not synchronous guarantees.

### Explicit Renewal Timeline

| Relative time | Auto-renew tier | Confirmation-required tier |
|---------------|-----------------|----------------------------|
| 30 days before year end | Renewal notice records `notice_sent`, mode `auto` | Confirmation request records `notice_sent`, mode `confirm` |
| Before year end | No new agreement | Member is told to confirm when the year opens |
| At/after year end | If notice already exists and no ordinary next-year record pre-empts it, cron re-simulates live terms and attempts a fresh agreement/snapshot/history/subscription using the active mandate | Cron waits; no charge is created |
| Member confirms | Not required | Existing start endpoint creates a fresh agreement, reuses mandate, and best-effort marks renewal `confirmed` |
| After creation | `renewal_confirmed` email | `renewal_confirmed`/mandate-active lifecycle applies through the start path |

This engine currently queries only `agreement_type='member'`; organisation agreements do not receive equivalent automatic DD renewal handling (`gocardlessDdRenewals.js` `processTenantDdRenewals()` lines 273–397). It also runs **after** ordinary member renewal processing in the same cron. A matching automatic/scheduled `member_membership_invoicing` row may therefore create the next-year record first; DD renewal then sees another-payment-method history and skips. Automatic DD renewal is not generally viable until that configuration/order interaction is excluded or resolved.

---

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `api/membership/direct-debit.js` | Individual start/status API, approval gate, agreement/history creation, hosted flow or mandate reuse |
| `api/membership/org-direct-debit.js` | Organisation self-payer and billing-contact start/status/admin invitation API |
| `api/membership/dd-self-service.js` | Member cancellation request and failed-payment/new-mandate recovery |
| `api/membership/payment-plan.js` | Member/admin plan views and per-instalment invoice display |
| `api/_lib/gocardless.js` | GoCardless client, API transformations, idempotency keys, signature verification |
| `api/_lib/gocardlessCredentials.js` | Tenant credentials, environment, and platform fallback resolution |
| `api/_lib/gocardlessDirectDebit.js` | Offer, immutable snapshot, collection date, subscription, activation, mandate reuse |
| `api/_lib/gocardlessState.js` | Canonical status graph, compare-and-set transitions, status audit |
| `api/webhooks/gocardless.js` | Raw-body signature verification, durable event insert, dispatch, acknowledgement |
| `api/_lib/gocardlessWebhookProcessor.js` | Billing request, mandate, subscription, payment, refund, and payout event routing |
| `api/_lib/gocardlessAccounting.js` | Confirmed DD collection posting to Xero or QuickBooks |
| `api/_lib/membershipInstalmentInvoicing.js` | Annual/per-instalment decision, invoice claim/idempotency, paid-invoice creation |
| `api/_lib/gocardlessArrears.js` | Snapshot grace, live arrears policy, retry safety, recovery |
| `api/_lib/gocardlessDdRenewals.js` | Individual notice, auto-renew, confirmation ledger, fresh annual agreement |
| `api/_lib/gocardlessDdInvitations.js` | Secure, expiring, single-live organisation payer invitations |
| `api/_lib/gocardlessDdEmails.js` | Lifecycle, invitation, migration, failure, completion, and renewal emails |
| `api/_lib/gocardlessMandateDiscovery.js` | Read-only discovery of pre-existing mandates into isolated staging |
| `api/admin/gocardless-dd.js` | RBAC-protected operational and finance console API |
| `api/admin/dd-cancellation-requests.js` | Admin review and execution of member cancellation requests |
| `api/admin/gocardless-mandate-discovery.js` | Admin-only staged mandate discovery API |
| `api/admin/membership-invoice-retry.js` | Manual annual membership invoice retry, with per-instalment suppression |
| `api/public/dd-invitations/[token].js` | Token-authenticated organisation payer invitation acceptance and hosted-flow creation |
| `api/cron/process-membership-renewals.js` | Hourly runner, tenant-hour gate, DD individual renewal notices/creation |
| `api/cron/reconcile-gocardless.js` | Six-hour drift repair and per-instalment accounting retry |
| `api/cron/gocardless-arrears.js` | Six-hour grace-expiry policy sweep |
| `client/src/components/forms/MembershipPaymentField.jsx` | Member choice and individual/organisation DD setup launch |
| `client/src/components/gocardless/GoCardlessDropinFlow.jsx` | Official GoCardless Drop-in wrapper |
| `client/src/components/membership/DirectDebitPlanCard.jsx` | Member plan, payment progress, arrears, cancellation UI |
| `client/src/pages/DirectDebitInvitationPage.jsx` | Public organisation payer review, authority confirmation, and redirect UI |
| `client/src/pages/DirectDebitAdmin.jsx` | Plan, cancellation, reconciliation, renewal, and migration administration |
| `client/src/pages/MembershipTierManagement.jsx` | DD tier settings and invoicing mode |
| `client/src/pages/admin/AdminIntegrations.jsx` | Tenant GoCardless integration and mandate-discovery controls |
| `supabase/migrations/20260726_gocardless_foundation.sql` | Core mirrors, agreement/plan, durable event, status history |
| `supabase/migrations/20260726_gocardless_phase2_dd_config.sql` | DD tier terms and member history link |
| `supabase/migrations/20260726_gocardless_phase3_org_dd.sql` | Organisation payer fields, history link, invitations |
| `supabase/migrations/20260728_gocardless_phase4_finance.sql` | Finance, refunds, payouts, arrears, cancellations, admin audit |
| `supabase/migrations/20260729_gocardless_phase5_renewals.sql` | Completion, renewal ledger, migration invites |
| `supabase/migrations/20260817_per_instalment_invoicing.sql` | Invoicing mode and durable instalment invoice store |
| `supabase/migrations/20260916_gocardless_mandate_discovery.sql` | Isolated discovery batches and rows |
| `vercel.json` | Cron cadence and 60-second API function duration |

### Design Principles

1. **Consent terms are immutable:** `metadata.dd` is written on each agreement so later tier changes do not alter an in-flight commitment.
2. **Provider state drives money state:** signed webhooks and reconciliation mirror GoCardless rather than trusting a browser return.
3. **Each membership year is a new agreement:** renewal never edits the completed agreement or subscription.
4. **Mandates outlive annual subscriptions:** an active mandate can be reused, while each subscription has a finite instalment count.
5. **State changes are monotonic:** `applyStatusTransition()` rejects duplicates and invalid regressions.
6. **Destructive events are verified:** mandate cancellation and chargeback paths re-fetch GoCardless before local destructive action.
7. **Tenant isolation is explicit:** user entry points resolve and compare tenant context, and admin queries are tenant-scoped.
8. **Accounting is provider-neutral:** the accounting facade writes generic columns while retaining Xero legacy columns.
9. **Emails are best-effort:** email failure must not roll back valid provider state.
10. **Discovery is staging only:** discovered mandates are not promoted into live billing mirrors or agreements.

---

## Terms, Offers, and Immutable Agreement Snapshots

`resolveDdOffer(simResult)` in `api/_lib/gocardlessDirectDebit.js` lines 39–74 requires a successful simulation, `dd_enabled=true`, and a positive monthly amount. Flat tiers read `membership_tier_config.dd_monthly_amount`; tiered pricing reads the matched band's `membership_tier_band.dd_monthly_amount`. Instalments are clamped to 1–12 and amounts sent to GoCardless are integer minor units.

```text
monthly_amount_minor = round(monthly_amount × 100)
instalment_count = clamp(parseInt(dd_instalment_count) or 12, 1, 12)
plan_total = monthly_amount_minor × instalment_count / 100
```

`buildAgreementSnapshot()` lines 125–150 stores:

- monthly amount in decimal and minor units;
- instalment count and plan total;
- currency;
- first-collection rule and collection day;
- activation rule;
- auto-renew value;
- grace days;
- terms version and acceptance timestamp;
- annual or per-instalment invoice mode;
- membership year/start, config, band, tier, annual cost, and simulated final cost.

**Important:** the history row's `final_cost` is set to `snapshot.plan_total`, not necessarily the simulation's annual `finalCost` (`direct-debit.js` lines 268–288; `org-direct-debit.js` lines 360–380). The explicit monthly offer is therefore the financial commitment.

The snapshot is not recomputed for payments, grace, activation, or invoice mode. Renewal intentionally creates a fresh snapshot from current tier terms (`gocardlessDdRenewals.js` `executeAutoRenewal()` lines 159–265).

---

## Individual Join Lifecycle

**File:** `api/membership/direct-debit.js` → `handlePost()`

1. `loadMember()` authorizes the session member or tenant admin, verifies tenant identity, and rejects members attached to organisations.
2. `getGocardlessCredentials()` must return an access token.
3. `simulateMembershipForMember()` resolves the current year and fee; `resolveDdOffer()` checks tier availability.
4. The optional membership approval gate runs before creating an agreement. Its catch is permissive: a DB error returns unblocked (`checkApproval()` lines 80–102).
5. Existing history paid by another method blocks DD. An open Stripe monthly-card agreement also blocks DD.
6. The deterministic agreement key is `dd-agree + tenant + member + year`. Re-entry returns the current URL/status.
7. The immutable snapshot is built.
8. An active local mandate is sought for the same member.
9. With no mandate, the endpoint creates a Billing Request and Billing Request Flow, using the request's forwarded origin for return/exit URLs.
10. With a mandate, the agreement starts in `mandate_pending`.
11. The agreement and pending history row are inserted and linked.
12. `setup_started` is sent; a pending confirmation renewal is best-effort marked confirmed.
13. Reuse creates the plan/subscription and evaluates activation immediately; otherwise the hosted authorization URL is returned.

**Key details:**

- The browser completion page is not proof of mandate activation; webhooks are authoritative.
- A 23505 agreement race is recovered by reloading the deterministic key.
- A history insert failure occurs after provider resources/agreement creation and returns 500; reconciliation does not generically reconstruct missing history.
- The approval check is fail-open on query exceptions and should be reviewed for production policy.

---

## Organisation Join Lifecycle

**File:** `api/membership/org-direct-debit.js` → `handleStart()`

The caller must be the supplied member or a tenant admin, and the member and organisation must share the resolved tenant (`loadOrgContext()` lines 63–108). The offer and approval flow mirror individual join.

### Self Payer

The requesting organisation member selects the self-payer route and proceeds to the bank-authorisation flow. `handleStart()` creates the Billing Request and hosted flow immediately, prefilling personal and company fields. An existing active organisation mandate is reusable only on this route (`org-direct-debit.js` lines 286–335).

**Authorization caveat:** `loadOrgContext()` proves only that the session member ID matches the supplied member and that the member belongs to the organisation, or that the caller is a tenant admin. It does not verify a primary-contact role or bank-signing authority. The endpoint then writes that caller into `primary_contact_member_id` and opens the hosted flow. UI wording or a payer assertion is not a server-enforced authority boundary. Organisation self-payer launch is blocked until the intended authorization policy is enforced or explicitly accepted and proved.

### Billing Contact

The endpoint validates an email, creates the agreement and history first, then creates a crypto-random, expiring invitation and emails `/dd-setup/{token}`. The GoCardless Billing Request/Flow is deliberately created when the invitation is accepted, not when it is sent, to avoid a stale flow (`org-direct-debit.js` lines 336–414). Admins can resend, change payer, or revoke while setup remains pending (`handleAdminAction()` lines 437–520); creating a fresh invitation supersedes prior pending links.

Lifecycle email recipients are the billing contact, when selected, plus the primary contact, deduplicated case-insensitively (`gocardlessDdEmails.js` `resolveDdEmailRecipients()` lines 173–220).

**Important:** organisation join is supported, but the renewal engine filters to member agreements. A completed organisation plan currently needs a separately proved/manual next-year path.

---

## Mandate Creation, Discovery, and Reuse

### Hosted/New Mandate

The join endpoint creates a mandate-request Billing Request, then a hosted flow. `billing_requests.fulfilled` attaches the provider customer/mandate IDs, upserts `gocardless_customers` and `gocardless_mandates`, and transitions the agreement. `mandates.active` creates the subscription. Cancelled/failed billing requests return setup to `payment_setup_required` and send `setup_incomplete`.

### Reuse

`findReusableMandate()` queries a tenant/entity's mirrored customers, then the most recently updated mandate with status exactly `active` (`gocardlessDirectDebit.js` lines 378–397). Reuse skips the hosted flow and immediately calls `ensureSubscriptionForAgreement()` and `activateMembershipForAgreement()`.

**Boundary:** local mirror status authorizes reuse; the reuse function does not first re-fetch the mandate from GoCardless. Sandbox proof must include a stale-local/remote-cancelled case.

**Shared-mandate terminal-event blocker:** reuse intentionally attaches the same mandate to multiple annual agreements. The agreement schema permits that cardinality, but `findAgreementByMandate()` in `gocardlessWebhookProcessor.js` uses `.maybeSingle()`. After renewal, a mandate terminal event can match both the prior and current agreement, raise before `findPlansByMandate()` executes, mark the webhook event failed, and still receive HTTP 200. The normal redelivery is then deduplicated without replay. Do not rely on mandate cancellation/failure/expiry to settle all reused-mandate plans until this is fixed or a complete operational repair is proved.

### Staged Mandate Discovery Is Not a Join Agreement

`runMandateDiscovery()` in `api/_lib/gocardlessMandateDiscovery.js` reads mandates from an explicitly tenant-owned integration (platform fallback is forbidden), fetches customer emails with concurrency 10, normalizes email, and classifies each row as matched, unmatched, ambiguous, or failed. It paginates provider pages of 100 and writes only:

- `gocardless_mandate_discovery_batch`
- `gocardless_mandate_discovery_row`

These tables have no foreign keys to live mirrors, billing agreements, plans, or membership history (`20260916_gocardless_mandate_discovery.sql` lines 1–74). A matched staging row **does not** create `gocardless_customers`, `gocardless_mandates`, `membership_billing_agreements`, a subscription, or a membership record. By contrast, a join-created agreement is a consent/year-specific operational object with `metadata.dd` and an idempotency key. Treating discovery as import or mandate reuse would be incorrect.

---

## Subscription Creation and Membership Activation

`ensureSubscriptionForAgreement()` uses the agreement ID/year to idempotently create `membership_payment_plans`, then calls GoCardless with the mandate, amount minor, currency, monthly interval, start/day constraint, and finite `count` (`gocardlessDirectDebit.js` lines 184–304).

### First Collection Rules

| Rule | Behaviour |
|------|-----------|
| `earliest` | No date/day constraint; GoCardless chooses the earliest eligible date |
| `nominated_day` | Monthly day clamped to 1–28 |
| `anniversary` | Membership-year start day, clamped to 28; first occurrence on/after earliest possible charge date |

`ensureSubscriptionForAgreement()` reads `gocardless_mandates.next_possible_charge_date` when it is available. The code uses that value directly only to choose the first `anniversary` occurrence. For `earliest`, both `start_date` and `day_of_month` are omitted. For `nominated_day`, only `day_of_month` is sent. In those two modes GoCardless, not application code, enforces the mandate scheme's earliest-charge constraint.

**Lead-time answer:** source code alone does not prove that collection lead time is sufficient. There is no application-level minimum number of days between agreement consent, annual invoice creation, and first charge. The provider should reject or defer an ineligible charge, but that is not equivalent to proving payer notice or invoice-before-collection timing. The 30-day renewal notice gives commercial notice for later individual terms; it does not create the renewal invoice, reserve a charge date, or cover a new join. Sandbox evidence must compare consent time, mandate `next_possible_charge_date`, subscription upcoming payment, invoice creation time, and payment confirmation time for every enabled rule and scheme.

### Activation Rules

| Rule | Mandate active | First payment confirmed | Admin requirement |
|------|----------------|-------------------------|-------------------|
| `mandate` | Membership becomes active | Also safe/idempotent | None |
| `first_payment` | Remains pending | Membership becomes active | None |
| `manual` | History becomes `pending_activation` | Remains pending activation | Admin must activate through another administrative membership path |

The DD history row begins `pending_payment_setup`; `activateMembershipForAgreement()` updates the linked member or organisation table and no-ops when already active (`gocardlessDirectDebit.js` lines 306–346).

---

## Invoice Timing and Accounting

### Exactly When Each Invoice Is Created

| Scenario | Invoice creation trigger | Earliest possible creation | Can collection confirm first? |
|----------|--------------------------|----------------------------|-------------------------------|
| Annual-mode new DD join | A separate ordinary membership invoicing path must create and link the annual invoice; DD start does not | Depends on a matching automatic/scheduled/manual membership invoicing path | **Yes.** The confirmed handler skips accounting when no invoice is linked |
| Annual-mode automatic membership processing | `process-membership-renewals` creates record and invoice together | Membership-year start, at the tenant's daily UTC processing hour | Normally invoice precedes later collection only if this path created the record; a pre-existing DD history row causes automatic processing to skip |
| Annual-mode scheduled processing | Cron invoices an existing record once `invoice_date <= today` | Configured invoice date, at the tenant's daily UTC processing hour | **Yes.** A DD charge can precede the scheduled date |
| Annual-mode manual/admin repair | Admin membership invoice action/retry | When an authorized admin acts | **Yes**, until the repair completes |
| Per-instalment new join or renewal | `payments.confirmed` calls `postDdInstalmentToAccounting()` and creates one invoice for that collection | Payment confirmation | No annual invoice should exist; the small invoice is created as part of confirmation processing, then the accounting payment is recorded |

The membership renewal cron's `automatic` and `scheduled` dates are accounting dates, not GoCardless collection constraints. Conversely, GoCardless subscription dates do not ensure an accounting invoice exists. These two clocks meet only through the linked membership-history row.

### Join and Renewal Timing by Invoice Mode

```text
New join, annual mode
T0 consent/history ── no annual invoice created by DD endpoint
T1 mandate active ── subscription created; provider determines eligible charge
Tx ordinary membership invoice path may create/link annual invoice
T2 payment confirmed ── apply part-payment only if Tx already happened
```

```text
New join, per-instalment mode
T0 consent/history ── annual invoice must be suppressed
T1 mandate active ── subscription created
T2 payment confirmed ── create one instalment invoice + record its payment
```

```text
Individual auto-renewal
year end - 30 days or next eligible daily run ── notice only; no invoice/subscription
year end or next eligible daily run ── ordinary member renewal runs first
                                      ├─ creates non-DD next-year history → DD renewal skips
                                      └─ does not create history → DD renewal attempts fresh agreement/history/subscription
first confirmed renewal payment ── annual part-payment if an annual invoice is linked,
                                    otherwise skipped; or one paid instalment invoice
```

```text
Individual confirmation-required renewal
year end - 30 days or next eligible daily run ── confirmation request only
year end onward ── no agreement, invoice, subscription, or charge until member confirms
confirmation ── normal start/reuse path
first confirmed payment ── same annual/per-instalment branch as a new join
```

Because the tenant renewal runner executes only at one configured UTC hour per day, "30 days before" and "at year end" mean the first successful eligible tenant run on or after those thresholds. Organisation DD agreements have no corresponding automatic DD renewal engine.

If the 30-day notice run is missed entirely, the first post-year-end run still performs only `send_notice`, because `decideRenewalAction()` always creates the renewal ledger before returning `renew_auto`. Auto-renew can occur no earlier than the next successful daily tenant window. It is not a same-run catch-up.

### Annual Mode

The snapshot default is `invoicing_mode='annual'`. Confirmed instalments are applied as part-payments to one accounting invoice already linked on the membership-history row (`gocardlessAccounting.js` lines 130–183).

**Critical timing detail:** the DD start endpoints do not create that annual invoice. They create an agreement and history row. `postDdInstalmentToAccounting()` marks a collection `skipped` when no invoice is linked. The general membership cron can create annual invoices for ordinary automatic/scheduled renewal records, but:

- its automatic branch skips any existing history record;
- its scheduled branch can invoice an existing record only if a matching scheduled invoicing row exists and its date has arrived;
- invoice creation exceptions are logged as non-fatal and the history record remains;
- the DD accounting reconciliation sweep deliberately does **not** automatically retry annual payment application.

See `process-membership-renewals.js` `processTenantMemberRenewals()` lines 1013–1117, `invoiceExistingMemberRecord()` lines 1388 onward, and `reconcile-gocardless.js` `retryFailedInstalmentInvoices()` lines 313–364.

Consequently, annual mode is code-supported only when an invoice is reliably pre-created/linked by the surrounding membership invoicing path. A direct DD join that creates the first history row has an evidence-backed invoice-linkage gap that must be proved or fixed before live use.

### Per-Instalment Mode

No annual invoice should exist. On each `payments.confirmed`, the payment row is atomically claimed (`pending|failed|invoice_unpaid`, or stale `posting` under reconciliation), one small invoice is created as paid, and linkage/status are persisted (`membershipInstalmentInvoicing.js`; `gocardlessAccounting.js` lines 77–127).

Protection has three layers:

1. compare-and-set claim to `posting`;
2. deterministic provider idempotency key based on payment ID;
3. persisted invoice linkage means retry applies payment rather than recreating invoice.

`posted` means both invoice and payment succeeded. `invoice_unpaid` means the invoice exists but the accounting payment could not be recorded. Annual-invoice paths call `shouldSuppressAnnualInvoice()` and fail closed if agreement mode cannot be established.

### Dedicated GoCardless Bank Account

The rail-specific settings are:

- Xero: `xero_gocardless_bank_account_code`
- QuickBooks: `quickbooks_gocardless_bank_account_id`

Per-instalment posting sets `strictBankAccount=true`: it must not fall back to a Stripe clearing account (`gocardlessAccounting.js` lines 99–115). Although the file header mentions historical fallback, the executable per-instalment path is strict. Missing or incorrect configuration leaves `invoice_unpaid`. Annual payment application passes the GC key but does not pass the strict flag; its provider-specific behaviour must be verified. A dedicated GC bank/clearing account mapping is therefore a go-live requirement, not an optional tidy-up.

### Non-Fatal Failure and Retry Assessment

- Annual membership invoice creation in the renewal cron catches provider errors and continues, recording a note/result rather than failing the cron item (`process-membership-renewals.js` lines 283–321 and 463–494 in the member path; analogous organisation path).
- `api/admin/membership-invoice-retry.js` offers a manual retry and suppresses annual invoices for per-instalment agreements.
- Per-instalment failed, `invoice_unpaid`, and stale `posting` rows are automatically retried by reconciliation.
- Annual-mode payment posting failures are intentionally not auto-retried due to double-application risk (`reconcile-gocardless.js` lines 313–318); an admin `reconcile` action can retry.

---

## Confirmed Payments, Completion, and Payouts

`processPaymentEvent()` mirrors payment status first. For `confirmed`/`paid_out`, it transitions the plan to active, clears arrears, transitions the agreement, applies first-payment activation, marks membership payment status `partial`, and attempts accounting. Accounting is attempted on `confirmed`, not again on `paid_out`, to avoid duplicate posting.

On `subscriptions.finished`, the plan becomes `expired`, `completed_at` is stamped, the linked membership history becomes `paid` with `paid_at`, and `plan_completed` is sent. Completion is subscription-event driven; the code does not independently count payments to mark full settlement.

**Missed-finish gap:** reconciliation can observe a remotely `finished` subscription and move the local plan to `expired`, but it does not stamp `completed_at`, settle membership history to `paid`, or send `plan_completed` (`reconcile-gocardless.js` `reconcileSubscriptionDrift()` lines 211–255). A missed or acknowledged-failed finish webhook can therefore leave an expired plan with partial/unpaid history and no completion notice.

Payout events fetch payout items, derive gross/fees/net per payment, attach payout reference/date, and upsert `gocardless_payouts` (`gocardlessWebhookProcessor.js` `processPayoutEvent()` lines 824 onward). Finance UI exposes pending, confirmed, paid-out, failed, chargeback, refund, and accounting-failure buckets.

---

## Renewal Lifecycle

`processTenantDdRenewals()` runs inside the hourly membership renewal job at each tenant's configured UTC hour. It considers only the latest individual DD agreement per member and excludes paused members.

1. At 30 days before the snapshotted year end, re-simulate the upcoming current year and resolve the live offer.
2. Read **live** `dd_auto_renew`; the old snapshot is not used to force a current commercial policy.
3. Send either `renewal_notice` or `renewal_confirmation_required`.
4. Upsert one `membership_dd_renewals` row per previous agreement/year.
5. At year end, auto mode attempts a fresh agreement, history, plan, subscription, and current-terms snapshot with the active mandate, but only if ordinary member renewal did not create the next-year history first.
6. Confirmation mode waits. Starting DD through the normal endpoint acts as confirmation and reuses the active mandate.
7. Previous agreement/plan remain immutable and completed.

Edge conditions in `decideRenewalAction()` include: only active/expired plans renew; malformed year starts/labels do not; terminal renewal rows do not rerun; another-payment-method history blocks DD; and an unavailable upcoming offer prevents notice/renewal.

**Gaps:** organisation renewals are excluded; ordinary automatic/scheduled member renewal runs first and can pre-empt DD renewal; a missed pre-year-end notice delays post-year-end auto-renew by at least one successful daily tenant window; a failed auto-renew outcome is logged in cron details but `executeAutoRenewal()` does not consistently persist renewal status `failed`/`failure_reason`; confirmation is best-effort; and there is no separate catch-up cadence outside the tenant-hour run.

The auto-renew writes are not transactional. In particular, history insert failure is logged and ignored before subscription creation. An agreement and live subscription can therefore exist without the expected next-year history row. Re-entry finds the deterministic agreement and returns early rather than replaying all missing side effects.

---

## Failure, Retry, Cancellation, Chargeback, Refund, and Arrears

### Payment Failure and Arrears

Failure opens or preserves a grace window using **snapshotted** `grace_days`; retries increment `retry_count`. Expired/repeated failures become overdue. The six-hour arrears sweep applies the **live** tier policy: `keep_active`, `restrict`, `suspend`, `manual_review`, or `cancel_at_period_end` (`gocardlessArrears.js`).

Most policies currently flag metadata/audit state; `cancel_at_period_end` does not itself call GoCardless, and restrict/suspend do not directly rewrite membership history in this helper. Operational enforcement must consume the flag.

### Retry and Replacement Mandate

Tenant admins configure automatic retries on the GoCardless integration card. The default is **disabled**; when enabled, the interval is 1–30 whole days (default 3) and the maximum is 0–10 automatic retries (default 3). The maximum counts provider retry requests **after** the original collection. Member/admin retries have their own ledger sequence and never consume `auto_retry_attempts`.

`scheduleAutomaticRetry()` runs only after a confirmed failed payment event. It calculates:

```text
next_due = failed_event_time + configured_interval_days
eligible = next_due < snapshotted_grace_expires_at
```

Equality with the grace deadline is not eligible. The grace deadline comes from the agreement snapshot and is never extended or restarted by retries. Every later failed webhook uses the current tenant policy to schedule the next attempt, but keeps the original deadline. Disabled policy, zero/used allowance, recovery, cancellation, manual resolution, unusable mandate, or grace expiry closes eligibility.

The 15-minute automatic retry sweep processes at most 100 plans for at most 45 seconds. `retryPaymentSafely()` reloads the tenant-owned plan/payment, checks mandate usability, current policy, due time, attempt limit and grace, takes a shared plan claim, then re-fetches GoCardless. Only live status exactly `failed` permits `retryPayment()`. The attempt-specific provider idempotency key and durable `gocardless_payment_retry_attempts` row make replay safe. Provider errors release the claim and schedule another check only when that due time is still strictly before grace.

Member and admin actions call the same service in manual mode. They share the claim with cron but use a separate manual attempt sequence. If the mandate is unusable, self-service creates a replacement hosted flow and moves the plan to `mandate_pending`. Accounting posting retries are unrelated: they retry invoice/payment recording after a collection succeeds and never affect the collection retry allowance.

### Cancellation

A member request inserts a pending `membership_dd_cancellation_requests` row; collections continue until review. The admin can approve/reject and choose subscription-only, mandate, or record-only handling. Direct admin `cancel_subscription` stops future collections while preserving mandate reuse; `cancel_mandate` relies on the webhook to settle local state. Mandate cancellation does not itself cancel membership (`mandate_cancelled` email says so). For a mandate reused across agreements, terminal webhook settlement is currently blocked by the single-agreement lookup described above.

### Chargeback

The webhook re-fetches payment state before action. A confirmed chargeback reopens arrears through the same grace machinery; if payout already occurred it sets `chargeback_reversed_after_payout=true` for finance attention.

### Refund

Finance-authorized admins may refund only mirrored `confirmed` or `paid_out` payments and cannot exceed unrefunded gross. `total_amount_confirmation` and deterministic idempotency protect concurrent refunds. Refund webhooks upsert `gocardless_refunds` and recompute the payment rollup from provider refunds, excluding failed/cancelled refunds.

---

## Webhook Durability and Tenant Routing

`api/webhooks/gocardless.js` disables body parsing, verifies HMAC-SHA256 over the raw bytes, then inserts each event into `payment_webhook_events` with unique `(provider,event_id)`. Failure to insert returns 500, so an event is never acknowledged without durable storage. New events are processed sequentially; status becomes processed, skipped, or failed.

### Acknowledged Failed Webhooks and Replay Gap

Processor exceptions are stored as `processing_status='failed'`, but the endpoint still returns HTTP 200 for the batch. On provider redelivery, the existing event conflicts, is labeled duplicate, and is **not reprocessed** (`gocardless.js` webhook endpoint lines 80–128). There is no generic job in the traced code that loads failed `payment_webhook_events.payload` and calls `processGocardlessEvent()` again.

The reconciliation cron repairs selected stale agreements, subscription drift, pending payments, and per-instalment accounting. It is not equivalent to replay: it does not cover every event side effect (for example all emails, history creation, invitation completion, refund/payout details, or arbitrary future event handlers). Therefore “durably logged and acknowledged” is true, while “automatically replayed” is not generally true. This is a production blocker unless an operational/manual replay mechanism and tested runbook are supplied.

### Tenant Webhook Routing

Tenant callbacks must be registered as:

```text
/api/webhooks/gocardless?tenant=<tenant-uuid>
```

The query parameter selects that tenant's webhook secret and GoCardless client. The stored event `tenant_id` is also that query value. A bare URL uses platform environment credentials. The endpoint does not infer tenant from event metadata before signature selection. Wrong, omitted, or stale query routing can therefore select the wrong secret/account or attribute the event incorrectly. Callback registration for every tenant/account/environment must be independently verified.

Resource lookups in the processor are commonly by globally unique GoCardless ID rather than `tenant_id`; this relies on global unique indexes and correct callback/account routing. It does not remove the routing requirement.

---

## Scheduled Jobs

| Job | Cadence | Limit/behaviour | Authentication |
|-----|---------|-----------------|----------------|
| `/api/cron/process-membership-renewals` | Hourly (`0 * * * *`) | Tenants run only at `membership_cron_time` hour; DD renewals sequential; API max duration 60s | Bearer `CRON_SECRET` only if env var is set |
| `/api/cron/reconcile-gocardless` | Every 6 hours at minute 15 | Maximum 100 per reconciliation group; five groups; heartbeat | Same conditional check |
| `/api/cron/gocardless-arrears` | Every 6 hours at minute 45 | Maximum 200 oldest eligible plans; no pagination in a run | Same conditional check |
| `/api/cron/gocardless-auto-retries` | Every 15 minutes | Maximum 100 due plans and 45 seconds; ordered by due time then plan ID | Bearer `CRON_SECRET`, fail-closed when missing |

Sources: `vercel.json` lines 34–162; cron handlers' `handler()` functions.

**Cron assessment:**

- The automatic retry cron is fail-closed when `CRON_SECRET` is missing. Older lifecycle crons remain fail-open because their condition is `if (cronSecret && header !== ...)`; that pre-existing operational risk is unchanged here.
- Schedule declarations prove intended cadence, not scheduler delivery. Deployment logs/heartbeat evidence are required.
- Membership processing gets one effective attempt per tenant/day because the hourly job gates to one UTC hour. A transient failure waits until the next day unless manually invoked.
- Reconciliation caps each group at 100 and arrears at 200; old rows can backlog. DD renewal scans are uncapped and sequential, risking the shared 60-second duration.
- Membership renewal and reconciliation have heartbeat integration; the arrears cron does not show a heartbeat reporter.

---

## Emails

`sendDdLifecycleEmail()` resolves recipients and calls `sendTenantEmail()`. It never throws to callers. Events include setup started/incomplete, mandate active/cancelled, first collection scheduled, membership activated, first/subsequent payment, failed/overdue/retry, at-risk escalation, plan cancelled/completed, renewal notice/confirmation-required/confirmed, organisation payer invitation, and migration invitation (`gocardlessDdEmails.js`).

Emails are deliberately not transactional evidence. A processed state with no email is possible. Conversely, event/state idempotency reduces duplicates but no dedicated email-delivery ledger is used by this module; admin detail refers to provider events/admin actions rather than proving mailbox delivery.

---

## Code Paths and Entry Points

### Individual Start/Status

**File/function:** `api/membership/direct-debit.js` → `handler()`, `handleGet()`, `handlePost()`  
**Trigger:** authenticated membership UI GET/POST.  
**Flow:** authorize → tenant/member check → simulate → approve → cross-method guard → snapshot → reuse or hosted flow → agreement/history → email → response.  
**Key detail:** `GET` returns only the latest agreement and redacts bank details.

### Organisation Start/Invitation Management

**File/function:** `api/membership/org-direct-debit.js` → `handleStart()`, `handleAdminAction()`  
**Trigger:** organisation membership UI or tenant admin.  
**Flow:** authorize context → choose payer → validate → simulate/approve → create agreement/history → hosted flow or secure invite → optional immediate reuse.  
**Key detail:** billing-contact selection always requires a new flow; self can reuse.

### Organisation Payer Invitation Acceptance

**File/function:** `api/public/dd-invitations/[token].js` → `handler()`, `handleGet()`, `handlePost()`  
**Trigger:** the invited payer opens `/dd-setup/:token`; no session is required because the 64-hex-character token is the credential.  
**Flow:** validate live, unexpired token → load same-tenant agreement → show immutable plan summary → require explicit authority confirmation → create or resume Billing Request flow → persist provider IDs and first acceptance time → return hosted authorization URL.  
**Key detail:** the invitation remains usable until webhook completion; an already attached Billing Request flow is returned idempotently.

### Webhook

**File/function:** `api/webhooks/gocardless.js` → `handler()`  
**Trigger:** GoCardless signed POST.  
**Flow:** raw body → tenant credentials → signature → durable dedupe → resource dispatcher → event status → 200.  
**Key detail:** failed processing is acknowledged and not generically replayed.

### Member Self-Service

**File/function:** `api/membership/dd-self-service.js` → `handlePost()`  
**Trigger:** plan card actions.  
**Flow:** authorize → latest DD context → cancellation request/withdrawal or payment recovery.  
**Key detail:** a cancellation request is review-only.

### Cancellation Review

**File/function:** `api/admin/dd-cancellation-requests.js` → `handler()`  
**Trigger:** an authorized tenant admin reviews a pending member request.  
**Flow:** tenant admin + DD feature RBAC → tenant-scoped pending request → optionally cancel subscription and mandate at GoCardless → transition plan/agreement → record decision and admin action → best-effort cancellation email.  
**Key detail:** approval supports `subscription`, `mandate`, or `none` scope; rejecting does not call GoCardless.

### Admin Console

**File/function:** `api/admin/gocardless-dd.js` → `handleGet()`, `handlePost()`  
**Trigger:** tenant admin UI.  
**Flow:** tenant admin + feature RBAC → tenant-scoped view/action → live provider call where needed → audited action.  
**Key detail:** refunds additionally require finance permission for role-based admins.

### Mandate Discovery

**File/function:** `api/admin/gocardless-mandate-discovery.js` → `handler()`; `gocardlessMandateDiscovery.js` → `runMandateDiscovery()`  
**Trigger:** integrations admin.  
**Flow:** admin auth → tenant-only credentials → paged read → email match → isolated staging summary.  
**Key detail:** no production billing records are imported.

---

## Safeguards and Error Handling

### Tenant and User Authorization

Member APIs require session self or admin, compare resolved and row tenant, and separate individual from organisation routes. Admin API combines tenant admin checks with `commerce.gocardless-dd`; refunds use `commerce.monthly-finance-report`. The organisation self-payer endpoint does not distinguish a designated primary contact from any other member of the organisation.

### Approval Before Agreement

```javascript
if (approval.blocked) {
  return res.status(403).json({ error: 'Your membership fees are awaiting approval...' });
}
```

The gate precedes agreement creation. **Caveat:** both individual and organisation approval helpers catch query errors and proceed.

### One Payment Method Per Year

Existing history with another payment method blocks DD; the individual route also checks an open Stripe agreement. The database has a unique member/year index and unique non-null member history agreement index (`20260819_member_membership_history_billing_agreement_unique.sql` lines 16–38). Organisation history relies on existing project constraints plus application checks and must be schema-verified.

### Provider and Local Idempotency

Deterministic keys cover agreements, Billing Requests, flows, subscriptions, retries, refunds, and instalment invoices. Database unique indexes handle races. Per-instalment posting claims rows atomically.

### Monotonic State

`applyStatusTransition()` loads state, validates the transition graph, updates only from the state it read, and writes `membership_payment_status_history` (`gocardlessState.js` lines 92–147).

### Destructive Verification

Mandate terminal, subscription cancellation, chargeback, and retry paths fetch current provider state. If fetch/confirmation fails, destructive local change is deferred. **This safeguard does not make shared-mandate handling complete:** the mandate path can fail before confirmation when more than one agreement matches the reused mandate.

### Annual Invoice Fail-Closed Check

Any operational error while determining per-instalment mode suppresses an annual invoice. Only recognized pre-migration table/column errors preserve legacy annual behaviour (`membershipInstalmentInvoicing.js` lines 60–109).

### Known Partial-Commit Boundaries

Provider resources may be created before local agreement/history writes complete. A history-link write may fail non-fatally. Email and status-history writes are non-fatal. These boundaries require reconciliation/attention monitoring and sandbox fault tests.

---

## Frontend UI and Administration

### Member UI

`MembershipPaymentField.jsx` starts `/api/membership/direct-debit` or `/api/membership/org-direct-debit`, opens `GoCardlessDropinFlow`, supports organisation payer choice, and displays `DirectDebitPlanCard`.

`DirectDebitPlanCard.jsx` displays monthly amount, payments made/remaining, next collection, membership year, agreement/payment state, per-instalment invoice numbers, arrears deadline, payment recovery, and cancellation request/withdrawal. It intentionally never exposes bank details.

`DirectDebitInvitationPage.jsx`, routed at `/dd-setup/:token`, fetches the invitation summary, requires the payer's authority confirmation, posts acceptance, and redirects the browser to the returned GoCardless authorization URL.

### Admin UI

`DirectDebitAdmin.jsx` provides:

- summary counts and attention indicators;
- searchable/status-filtered plan list and detail;
- payment/refund/status/admin/cancellation histories;
- retry, refund, reconcile, pause/resume, subscription/mandate cancel, grace extension, manual resolve, reminder, new mandate link, and notes;
- cancellation decision queue;
- payment/payout reconciliation and CSV;
- individual renewal ledger;
- migration funnel.

`AdminIntegrations.jsx` adds an **Automatic collection retries** section to the GoCardless card. Saving calls `POST /api/admin/integrations` with the enabled flag, whole-day interval, and maximum. Server validation is authoritative. Disabling the policy (or the integration), or setting the maximum to zero, immediately clears tenant due schedules without changing the snapshotted grace deadline.

### Mutations

| UI | Endpoint | Method | Purpose |
|----|----------|--------|---------|
| Membership payment | `/api/membership/direct-debit` | POST | Start individual DD |
| Organisation payment | `/api/membership/org-direct-debit` | POST | Start self/invited payer DD |
| Org payer admin | same | POST | Resend/change/revoke payer link |
| Plan card | `/api/membership/dd-self-service` | POST | Retry/new mandate/cancellation request/withdraw |
| Admin console | `/api/admin/gocardless-dd` | POST | Audited plan/finance/migration actions |
| Cancellation queue | `/api/admin/dd-cancellation-requests` | POST | Approve/reject request and cancellation scope |
| Integration discovery | `/api/admin/gocardless-mandate-discovery` | POST | Run read-only staged discovery |
| GoCardless integration | `/api/admin/integrations` | POST | Save credentials, enabled state, and tenant automatic retry policy |
| Invoice repair | `/api/admin/membership-invoice-retry` | POST | Retry annual accounting invoice |

### Cache Invalidation

Admin actions invalidate the `/api/admin/gocardless-dd` query prefix; cancellation decisions also invalidate `/api/admin/dd-cancellation-requests`; migration actions invalidate their migration key (`DirectDebitAdmin.jsx` lines 202–214, 383–411, 565–599, 733–758). `DirectDebitPlanCard` uses local fetch state and explicitly reloads self-service state after a mutation rather than React Query invalidation.

---

## Database Tables

Types below summarize migrations; existing membership tables contain additional columns outside this subsystem.

### `gocardless_customers`

| Column(s) | Type | Description |
|-----------|------|-------------|
| `id`, `tenant_id`, `member_id`, `organization_id` | UUID | Local identity/ownership |
| `gocardless_customer_id` | TEXT unique | Provider customer |
| `email`, `environment`, `metadata`, timestamps | mixed | Mirror context |

### `gocardless_mandates`

| Column(s) | Type | Description |
|-----------|------|-------------|
| identity/provider/customer IDs | UUID/TEXT | Mandate mirror |
| `status`, `scheme`, `reference` | TEXT | Provider state |
| `next_possible_charge_date` | DATE | Subscription date input |
| `environment`, `metadata`, timestamps | mixed | Audit context |

### `membership_billing_agreements`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/member/org/type | UUID/TEXT | Membership payer scope |
| GC customer, mandate, request, flow IDs | TEXT | Provider setup links |
| `status`, `idempotency_key`, `redirect_url`, `environment` | TEXT | Journey and replay state |
| `needs_attention`, `attention_reason` | BOOLEAN/TEXT | Reconciliation queue |
| primary/billing contact fields, `dd_payer`, `mandate_completed_by` | mixed | Organisation payer model |
| `metadata` | JSONB | Immutable `dd` snapshot and operational flags |

### `membership_payment_plans`

| Column(s) | Type | Description |
|-----------|------|-------------|
| identity/agreement/entity/tenant | UUID | Local links |
| subscription/mandate IDs | TEXT | GoCardless plan resources |
| amount/currency/interval/day/year/start/next date/count | mixed | Collection schedule |
| status/last payment/retry | mixed | Lifecycle |
| grace extension/expiry/policy fields | mixed | Arrears |
| `auto_retry_attempts`, `auto_retry_next_at`, `auto_retry_payment_id` | mixed | Automatic allowance consumed and current due payment |
| `auto_retry_claimed_at`, `auto_retry_claim_token` | mixed | Shared cron/member/admin concurrency claim |
| `auto_retry_last_outcome`, `auto_retry_last_error`, `auto_retry_exhausted_at` | mixed | Durable operational state |
| `completed_at`, attention, environment, metadata, timestamps | mixed | Completion/operations |

### `gocardless_payment_retry_attempts`

| Column(s) | Type | Description |
|-----------|------|-------------|
| `tenant_id`, `plan_id`, `gocardless_payment_id` | UUID/TEXT | Tenant-owned collection linkage |
| `attempt_number`, `mode` | INTEGER/TEXT | Separate automatic or manual sequence |
| `status`, `outcome`, `error_message`, `provider_status` | TEXT | Claimed/requested/refused/failed/recovered audit |
| `idempotency_key` | TEXT unique | Attempt-specific provider replay protection |
| `claimed_at`, `completed_at`, timestamps | TIMESTAMPTZ | Timing and scheduler diagnosis |

### `gocardless_payments`

| Column(s) | Type | Description |
|-----------|------|-------------|
| identity/tenant/plan/provider IDs | mixed | Payment mirror |
| amount/currency/status/charge date/description | mixed | Collection |
| fee/net/payout/refund/chargeback fields | mixed | Finance reconciliation |
| generic and Xero invoice IDs/numbers | TEXT | Accounting linkage |
| accounting sync status/error/time/provider | mixed | Posting state |

### `payment_webhook_events`

| Column(s) | Type | Description |
|-----------|------|-------------|
| provider/event/resource/action/tenant | mixed | Unique event envelope |
| `payload` | JSONB | Replay-capable source payload, though no generic replay job exists |
| processing status/error/received/processed | mixed | Durable processing result |

### `membership_payment_status_history`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/entity/payment IDs | mixed | Subject |
| from/to/reason/source/event/metadata/time | mixed | Immutable state audit |

### `membership_dd_invitations`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/org/agreement/token | mixed | Secure organisation payer link |
| status/email/name/inviter | mixed | Recipient/lifecycle |
| expiry/accept/complete/revoke timestamps | TIMESTAMPTZ | Single-use enforcement |

### `gocardless_refunds`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/refund/payment/local payment IDs | mixed | Refund mirror |
| amount/currency/status/reason/initiator/key | mixed | Refund lifecycle/audit |
| environment/metadata/timestamps | mixed | Context |

### `gocardless_payouts`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/provider ID/reference | mixed | Payout identity |
| amount/fees/currency/status/arrival | mixed | Settlement |
| reconciled/difference/environment/metadata/timestamps | mixed | Finance control |

### `membership_dd_cancellation_requests`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/plan/agreement/member/org | UUID | Request scope |
| requester/reason/preference/status/snapshot | mixed | Member request |
| decider/time/notes/timestamps | mixed | Review audit |

### `membership_dd_admin_actions`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/plan/agreement/payment | mixed | Action target |
| action/actor/details/time | mixed | Append-only operational audit |

### `membership_dd_renewals`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/member/previous/new agreement | mixed | Annual lineage |
| renewal year/mode/status | TEXT | Decision ledger |
| notice/confirm/failure/timestamps | mixed | Outcome |

### `membership_dd_migration_invites`

| Column(s) | Type | Description |
|-----------|------|-------------|
| tenant/member/token/email/inviter | mixed | Existing-member invitation |
| switch year/status/agreement/notes | mixed | Migration state |
| expiry/accept/decline/timestamps | mixed | Lifecycle |

### `membership_instalment_invoices`

Stores Stripe monthly-card instalment accounting rows. GoCardless uses equivalent accounting columns on `gocardless_payments`. Columns cover tenant/plan/agreement/provider/external payment, amount/currency, invoice linkage, sync status/error/time, and timestamps.

### Membership and Configuration Tables

- `membership_tier_config`: DD enabled, instalments, flat amount, first collection, day, activation, auto-renew, grace, terms version, arrears policy, migration, invoicing mode.
- `membership_tier_band`: tiered DD monthly amount plus normal band/VAT/nominal fields.
- `member_membership_history` and `organisation_membership_history`: membership-year cost, payment method/status, accounting invoice, and `billing_agreement_id`.
- `member_membership_invoicing` and `organisation_membership_invoicing`: automatic/scheduled/manual annual membership processing and fee approval.
- `tenant_integrations`: encrypted tenant GoCardless credentials and enabled state.
- `system_settings`: approval, cron time, accounting bank account, nominal ledger, and related operational values.
- `scheduled_task_log`: cron run audit.

### Discovery Tables

`gocardless_mandate_discovery_batch` stores one tenant/environment run and summary; `gocardless_mandate_discovery_row` stores provider mandate/customer/email match outcomes. RLS is enabled and public/anon/authenticated access is revoked; server admin API mediates access.

---

## Data Flow Diagrams

### New Individual Mandate

```text
Member chooses DD
  → simulate current membership and resolve offer
    → create immutable agreement + pending history
      → create Billing Request/Flow
        → payer completes GoCardless
          → signed billing-request webhook attaches customer/mandate
            → mandate active webhook creates finite subscription
              → activation rule evaluated
                → confirmed payment → partial + accounting + email
                  → subscription finished → paid + completed
```

### Organisation Billing Contact

```text
Primary contact chooses billing contact
  → agreement/history created; no GC flow yet
    → secure invitation emailed
      → contact accepts single-use link
        → Billing Request/Flow created
          → normal webhook-driven mandate/subscription lifecycle
```

### Reused Mandate Renewal

```text
30-day cron notice
  → membership_dd_renewals.notice_sent
    → year starts
      → ordinary member renewal pass runs first
        → ordinary next-year history created? DD renewal skips
        → otherwise current terms simulated
          → fresh agreement snapshot; history attempted
            → existing active mandate reused
              → fresh finite subscription
                → prior agreement/plan remain unchanged
```

### Confirmed Payment and Accounting

```text
payments.confirmed
  → durable event insert
    → payment mirror + amount enrichment
      → plan/agreement active
        → annual mode? apply part-payment to linked annual invoice
        → per_instalment? claim payment → create/reuse small invoice → record payment
          → posted | invoice_unpaid | failed | skipped
```

### Failure and Recovery

```text
payments.failed
  → snapshot grace window + retry count
    → member/admin retry?
      → fetch GC payment; must still be failed
        → idempotent retry
    → grace expires
      → six-hour arrears sweep
        → apply live policy + flag agreement + escalation email
          → later success clears arrears
```

---

## External Integrations

### GoCardless

Outbound data includes amounts in minor units, currency, finite count, collection constraints, payer prefill, redirect/exit URLs, and tenant/agreement/plan metadata. Inbound signed events supply resource/action/link IDs; thin payloads are enriched by API reads. Credentials/environment are tenant-specific first, then platform fallback except mandate discovery.

### Xero and QuickBooks Online

The accounting facade creates annual or instalment invoices and records confirmed payments. Generic `accounting_*` columns are authoritative across providers; `xero_*` columns remain for compatibility. Dedicated GC clearing/bank-account configuration must match the connected accounting organization.

### Tenant Email

`sendTenantEmail()` sends payer lifecycle messages under tenant delivery configuration. Failure is logged and returned but does not fail webhook state.

---

## Configuration Reference

| Setting | Location | Values | Default | Description |
|---------|----------|--------|---------|-------------|
| `dd_enabled` | tier config | boolean | false | Offer monthly DD |
| `dd_monthly_amount` | tier config/band | positive decimal | null | Explicit instalment |
| `dd_instalment_count` | tier config | 1–12 | 12 | Fixed subscription count |
| `dd_first_collection_rule` | tier config | earliest/nominated_day/anniversary | earliest | Initial schedule |
| `dd_collection_day` | tier config | 1–28/null | null | Nominated day |
| `dd_activation_rule` | tier config | mandate/first_payment/manual | first_payment | Membership activation |
| `dd_auto_renew` | tier config | boolean | true | Auto or confirmation renewal |
| `dd_grace_days` | tier config/snapshot | 0–90 at runtime | 7 | Contractual grace |
| `dd_terms_version` | tier config | text | `v1` in resolver | Consent version |
| `dd_arrears_policy` | tier config | five policies | manual_review | Live post-grace action |
| `dd_migration_enabled` | tier config | boolean | false | Existing-member migration |
| `dd_invoicing_mode` | tier config/snapshot | annual/per_instalment | annual | Accounting timing |
| `membership_require_approval` | system settings | `true`/other | not required | Agreement gate |
| `membership_cron_time` | system settings | `HH:mm` UTC | 06:00 | Daily tenant processing hour |
| `xero_gocardless_bank_account_code` | system settings | account code | none | GC Xero clearing account |
| `quickbooks_gocardless_bank_account_id` | system settings | account ID | none | GC QBO clearing account |
| GoCardless credentials | tenant integration | token, webhook secret, sandbox/live, creditor | platform env fallback | API/webhook identity |
| Automatic retries enabled | GoCardless tenant integration | boolean | false | Allow iConnect collection retry requests |
| Automatic retry interval | GoCardless tenant integration | 1–30 whole days | 3 | Delay from each confirmed failure; sweep precision is up to 15 minutes later |
| Maximum automatic retries | GoCardless tenant integration | 0–10 | 3 | Automatic requests after the original collection; excludes manual retries |
| `GOCARDLESS_*` | environment | credentials/environment/base URL | sandbox/no credential | Platform fallback |
| `INTEGRATION_ENCRYPTION_KEY` / `SESSION_SECRET` | environment | secret | none | Tenant credential decryption |
| `CRON_SECRET` | environment | secret | none | Cron bearer; missing currently disables auth |
| heartbeat URLs | environment | URL | none | Renewal/reconciliation monitoring |

---

## Deployment Readiness Audit

### Evidence Basis

Read-only DEST inspection dated **2026-09-01** found that all listed foundation/phase tables and queried columns resolved. Counts were:

| Object | Rows | Object | Rows |
|--------|-----:|--------|-----:|
| GoCardless customers | 0 | GoCardless mandates | 0 |
| Billing agreements | 0 | Payment plans | 0 |
| GoCardless payments | 0 | Webhook events | 96 |
| Status history | 0 | DD invitations | 0 |
| Refunds | 0 | Payouts | 1 |
| Cancellation requests | 0 | Admin actions | 0 |
| DD renewals | 0 | Migration invites | 0 |
| Tier configs | 24 | Tier bands | 36 |
| Member membership history | 463 | Organisation membership history | 357 |
| Instalment invoices | 0 |  |  |

Configuration/status evidence also showed **2 enabled tenant GoCardless integrations**, **7 DD-enabled tier configs**, **0 pending/failed GoCardless webhook rows**, and **0 failed/`invoice_unpaid`/`posting` GoCardless accounting rows**.

This proves **schema/configuration presence only**. It does **not** prove working or correctly decrypted credentials, correct GoCardless creditor/bank account, live versus sandbox alignment, webhook endpoint registration or tenant query routing, scheduler delivery, email delivery, accounting connectivity, dedicated GC bank-account settings, or any lifecycle behaviour. Workspace memory identifies DEST as the production target, but direct production identity cannot be independently established from this audit.

The 96 event rows and one payout do not overcome the absence of linked GC lifecycle records; they may relate to other GoCardless uses or prior activity and are not presented as membership proof.

### Test Coverage Evidence

Focused source tests exist for the GoCardless client and credentials, agreement/collection decisions, invitation and migration logic, renewal decisions, arrears, webhook processing, mandate discovery, accounting-provider arguments, and membership instalment invoicing:

- `api/_lib/gocardless.test.mjs`
- `api/_lib/gocardlessCredentials.test.mjs`
- `api/_lib/gocardlessDirectDebit.test.mjs`
- `api/_lib/gocardlessDdInvitations.test.mjs`
- `api/_lib/gocardlessDdMigration.test.mjs`
- `api/_lib/gocardlessDdRenewals.test.mjs`
- `api/_lib/gocardlessArrears.test.mjs`
- `api/_lib/gocardlessWebhookProcessor.test.mjs`
- `api/_lib/gocardlessMandateDiscovery.test.mjs`
- `api/_lib/membershipInstalmentInvoicing.test.mjs`
- `api/_lib/accountingProviderInvoiceArgs.test.mjs`

These tests are valuable code evidence but are not deployment evidence. They do not prove real GoCardless lead times, callback registration, tenant credential decryption, scheduler delivery, email receipt, Xero bank-account selection, or sandbox invoice/payment settlement. The sandbox proof script is also **not read-only against GoCardless**: it creates a Billing Request and hosted flow, so it must run only as an approved sandbox scenario, never as a read-only deployment check.

### Readiness Labels

- **code-complete:** traced implementation exists with coherent guards.
- **schema/config verification required:** deployment values/constraints must be checked read-only.
- **sandbox proof required:** behaviour must be demonstrated with non-live money.
- **production-operational proof required:** scheduler/provider/dashboard evidence is needed after controlled enablement.
- **blocked:** do not enable live collections until resolved.

### Evidence-Backed Matrix

| Area | Label | Assessment / required evidence |
|------|-------|--------------------------------|
| Core schema and queried columns | schema/config verification required | DEST objects and sampled columns resolved; deployed constraints/indexes/RLS were not independently catalog-verified |
| Tenant integration rows / DD tier enablement | schema/config verification required | Rows exist, but secrets and effective settings were not exposed or tested |
| Individual new-mandate join | sandbox proof required | Code traced; zero agreements/mandates/plans/payments provide no behavioural proof |
| Individual active-mandate reuse | blocked | Must prove local/remote alignment and resolve terminal-event lookup across multiple yearly agreements |
| Organisation self payer | blocked | Any organisation member may initiate; no server-side primary-contact/bank-authority policy is enforced |
| Organisation billing-contact invite | sandbox proof required | Must prove expiry, single-use, resend/change/revoke, callback |
| Immutable snapshot | code-complete | Snapshot fields and fresh-renewal behaviour traced |
| Subscription and activation modes | sandbox proof required | Especially manual activation and first-payment timing |
| Per-instalment accounting idempotency/retry | sandbox proof required | Strong code guards; no DEST rows prove operation |
| Annual invoice availability for DD-created row | blocked | Start does not mint invoice; auto cron skips existing history; prove surrounding path or fix |
| Non-fatal annual invoice failure | blocked | Cron may continue with history but no invoice; alert/retry ownership must be established |
| Annual accounting auto-retry | blocked | Explicitly absent to avoid double-apply; manual safe-retry runbook/control required |
| Dedicated GC Xero/QBO bank account | blocked | Presence/correctness was not proven; per-instalment strict mode requires it |
| Payment, completion, payout | sandbox proof required | Zero membership payments/plans; one unlinked payout is insufficient |
| Individual renewal notice/auto/confirm | blocked | Ordinary member renewal can pre-empt DD; missed notice adds a daily-run delay; partial writes are not fully replayed |
| Organisation DD renewal | blocked | Renewal query intentionally limits to member agreements |
| Failure/grace/retry/recovery | sandbox proof required | Need remote failed-state and no-double-charge proof |
| Mandate terminal handling after reuse | blocked | Shared mandate can match multiple agreements while webhook lookup requires one; failed event has no generic replay |
| Cancellation/refund/chargeback | sandbox proof required | Money/destructive actions require provider evidence; reused-mandate cancellation remains separately blocked |
| Durable event insert/dedupe | code-complete | Unique insert and raw signature path traced |
| Failed-event generic replay | blocked | Failed rows are acknowledged; duplicate redelivery skips; no generic replay worker |
| Reconciliation coverage | blocked | Selective repair is not full replay; missed `subscriptions.finished` does not settle history/completion side effects |
| Tenant webhook routing | blocked | Every tenant live callback with `?tenant=` and matching secret/account must be proved |
| Live/sandbox alignment | blocked | Row existence does not prove token, client base URL, callbacks, and stored environment match |
| Cron authentication | blocked | Handler is unauthenticated when `CRON_SECRET` is unset |
| Cron cadence/throughput | production-operational proof required | Verify Vercel delivery, heartbeats/logs, 100/200 caps, tenant daily gate, 60s duration |
| Lifecycle email delivery | sandbox proof required | Best-effort code is not delivery proof |
| UI/RBAC/admin audit | sandbox proof required | Server RBAC traced; action and tenant-isolation tests needed |
| Staged mandate discovery | code-complete | Isolated/read-only by design; must never be treated as imported agreements |
| Overall live membership DD launch | blocked | Resolve all blocked rows and collect sandbox/operational evidence first |

---

## No-Mutation Verification Checklist

Perform these in order without creating provider or application records:

1. Confirm the target environment identity using an approved independent deployment record; do not rely only on workspace memory.
2. Confirm all migrations, constraints, unique indexes, RLS/revokes, and queried columns, including member/org history agreement links and invoice sync fields.
3. Confirm exactly which tenants are intended for launch; verify enabled integration environment values without displaying tokens/secrets.
4. Verify token prefix/environment, configured GoCardless API base, creditor, and webhook secret all refer to the same sandbox/live account by metadata-only checks where possible.
5. Verify each provider dashboard callback URL includes the correct tenant query value and points to the intended deployment; verify subscribed resource types/actions.
6. Confirm bare platform callback is either intentionally configured or unused.
7. Confirm `CRON_SECRET` is set in the deployment and scheduler authorization is configured; confirm unauthorized requests are expected to return 401.
8. Confirm scheduler definitions and recent deployment-level invocation evidence for all three jobs without invoking them.
9. Check heartbeat configuration/monitor ownership for renewal and reconciliation; define equivalent monitoring for arrears.
10. Estimate eligible row volume against 100/200 group caps and 60-second duration; establish backlog alerts.
11. Verify each DD-enabled tier's monthly amount, count, collection rule/day, activation, auto-renew, grace, terms version, arrears policy, and invoice mode.
12. Verify approval settings and approved rows; decide whether fail-open approval query handling meets policy.
13. For annual mode, trace how each join path obtains a linked annual invoice before the first collection; block any path without one.
14. Verify accounting provider connection and dedicated GC Xero/QBO bank account mapping; confirm it is not a Stripe account.
15. Confirm nominal code, VAT, invoice description/address, and contact mappings.
16. Query pending/failed/skipped webhook and accounting statuses, stale `posting`, attention flags, overdue plans, and unlinked annual-mode histories.
17. Establish a controlled generic failed-event replay procedure with tenant-correct credentials and idempotency review.
18. Establish manual annual accounting retry/reconciliation ownership and a no-double-apply check.
19. Confirm email domain/sender/template delivery configuration and operational alerting.
20. Confirm organisation renewal policy; do not promise automatic DD renewal while the code handles only individuals.
21. For individual DD renewal, verify there is no automatic/scheduled ordinary member invoicing row that can create the target-year record before the DD pass, or keep renewal blocked.
22. Define repair for an expired plan whose finish event did not stamp `completed_at`, settle history, or send completion notice.
23. Define and enforce who may initiate organisation self-payer DD; do not treat `primary_contact_member_id` written during setup as proof the caller was a primary contact.
24. Resolve the shared-mandate agreement lookup and prove one terminal mandate event settles every affected current plan without losing the event.

---

## Representative Sandbox Go-Live Scenarios

Run with unique test members/organisations and retain redacted provider IDs, timestamps, event rows, state transitions, emails, invoices, and reconciliation results.

1. Individual, no mandate, annual invoice, `first_payment` activation: prove linked annual invoice exists before confirmation and each instalment applies exactly once.
2. Individual, no mandate, per-instalment: prove no annual invoice, one paid invoice per confirmed collection, correct dedicated GC account.
3. Individual active mandate reuse: prove no hosted flow and exactly one new subscription.
4. Stale local active mandate but remotely cancelled: prove no unsafe collection and documented recovery.
5. Organisation self payer: prove the intended server-side initiator/authority policy, org history, and dual-recipient email dedupe.
6. Organisation billing contact: prove invite expiry, supersession, single use, resend/change/revoke, then successful activation.
7. Each activation rule: mandate, first payment, and manual.
8. Earliest, nominated day, and anniversary date rules, including day >28 clamp and signup after this month's anniversary.
9. Duplicate start, concurrent start, duplicated/out-of-order webhook: prove one agreement/history/subscription/invoice/payment.
10. Deliberate webhook processing failure followed by provider redelivery: demonstrate the current replay gap, then exercise approved repair.
11. Missed mandate/subscription/payment event: prove exactly what reconciliation repairs and what it only flags.
12. Per-instalment crash-after-invoice and crash-after-payment: prove deterministic provider idempotency and linkage retry.
13. Annual payment application failure: prove no auto-retry, admin reconcile safety, and no duplicate accounting payment.
14. Missing/wrong dedicated bank setting: prove `invoice_unpaid`, retained invoice linkage, and successful retry after correction.
15. Payment failure before/after grace, retry, successful recovery, and each arrears policy.
16. Dead mandate replacement: prove old subscription cannot parallel-charge.
17. Subscription-only cancellation versus mandate cancellation; prove membership itself is not silently cancelled.
18. Partial/full refund, concurrent refund guard, failed refund rollup.
19. Chargeback before and after payout; prove finance flag and arrears.
20. Subscription finish: prove plan expired/completed timestamp, history paid, completion email.
21. Individual auto-renew: notice at day -30, current-price snapshot, mandate reuse, new subscription.
22. Individual confirmation renewal: no charge without confirmation; confirmation creates one new year.
23. Paused member and alternative payment history: prove renewal exclusion.
24. Organisation year-end: demonstrate the absent automated renewal and approved manual process.
25. Ordinary automatic/scheduled member invoicing plus DD auto-renew: prove the current pre-emption branch and prevent duplicate/wrong-method renewal.
26. Miss the pre-year-end renewal window deliberately: prove the first late run sends notice only and renewal waits for the next daily window.
27. Miss `subscriptions.finished`: prove reconciliation leaves completion side effects incomplete and exercise the approved repair.
28. Tenant A/Tenant B callbacks: prove signatures, API clients, records, and emails cannot cross tenants.
29. Sandbox/live mismatch: prove loud rejection/no mutation.
30. Cron backlog above 100 reconciliation rows and 200 arrears rows, plus enough renewals to approach 60 seconds.
31. Email failures at each milestone: prove state continues and operations can identify/resend where supported.
32. Reuse one mandate across two annual agreements, then terminate it: prove all affected plans settle idempotently and the durable event reaches `processed`.

---

## Troubleshooting

### Problem: Direct Debit option is unavailable
**Symptom:** UI hides/refuses DD.  
**Cause:** no credentials, `dd_enabled=false`, no positive flat/band monthly amount, no matched tier, or individual/org route mismatch.  
**Fix:** inspect simulation, tenant integration metadata, and tier/band settings; do not expose tokens.

### Problem: Hosted flow returns but plan never appears
**Symptom:** Agreement remains setup/mandate pending.  
**Cause:** wrong callback tenant query/secret, missing callback, unfulfilled request, failed acknowledged event, or missing subscription side effect.  
**Fix:** inspect durable event status, agreement provider IDs, callback registration, and reconciliation attention flags; replay only through the approved tenant-correct procedure.

### Problem: Event is `failed`, but provider redelivery does nothing
**Symptom:** redelivery is shown as duplicate.  
**Cause:** dedupe skips every existing event ID, including failed events.  
**Fix:** use the approved manual replay/repair runbook; reconciliation is only partial coverage.

### Problem: Payment is confirmed but accounting is skipped
**Symptom:** `accounting_sync_status='skipped'`, no invoice payment.  
**Cause:** no provider or no annual invoice linked.  
**Fix:** determine invoice mode. For annual mode, safely create/link the annual invoice then use admin reconcile. Never create an annual invoice for per-instalment mode.

### Problem: Instalment invoice is unpaid
**Symptom:** invoice exists and status is `invoice_unpaid`.  
**Cause:** dedicated GC bank account could not record payment.  
**Fix:** correct `xero_gocardless_bank_account_code` or `quickbooks_gocardless_bank_account_id`; reconciliation reuses the linked invoice.

### Problem: Annual invoice creation failed
**Symptom:** history exists without invoice; cron may report processed.  
**Cause:** provider/contact/config error is non-fatal.  
**Fix:** inspect history sync/error and notes, verify it is annual mode, use the admin invoice retry, and then reconcile payment. Add operational alert ownership.

### Problem: Retry is refused
**Symptom:** HTTP 409 says payment may already be in progress.
**Cause:** GoCardless no longer reports exactly `failed`, the mandate is unusable, or another member/admin/cron retry owns the shared claim.
**Fix:** inspect the plan's automatic retry outcome and attempt ledger. Do not force a new collection when live state is not `failed`; let a current claim finish or use replacement-mandate recovery when appropriate.

### Problem: Automatic retry remains scheduled but is not requested
**Symptom:** `auto_retry_next_at` is due, but no provider retry appears.
**Cause:** the 15-minute sweep was delayed, policy/integration was disabled, allowance was exhausted, grace expired, the mandate changed, another retry claimed the plan, live payment recovered, or the provider returned an error.
**Fix:** inspect `scheduled_task_log` for `gocardless_auto_retries`, plan `auto_retry_last_*` fields, and `gocardless_payment_retry_attempts`. Verify the tenant-owned integration is enabled. Never move `grace_expires_at` to make a retry eligible.

### Problem: Renewal notice did not send
**Symptom:** no renewal ledger row at day -30.  
**Cause:** organisation agreement, non-active/expired plan, paused member, unavailable offer, malformed snapshot year start, tenant-hour cron not delivered, or email failure.  
**Fix:** inspect eligibility and cron evidence. Organisation DD is not handled by this engine.

### Problem: Wrong tenant's webhook secret is used
**Symptom:** 498 invalid signature or unexplained bare-platform attribution.  
**Cause:** missing/incorrect `?tenant=` callback registration.  
**Fix:** correct the provider dashboard URL and verify environment/account alignment; never bypass signature validation.

### Problem: Reused mandate cancellation webhook is `failed`
**Symptom:** a terminal mandate event is durable but plans remain active and provider redelivery is a duplicate.  
**Cause:** more than one yearly agreement references the mandate while the webhook agreement lookup requires at most one row.  
**Fix:** keep reused-mandate cancellation blocked and use the approved tenant-scoped repair procedure until multi-agreement handling and replay are implemented and proved.

### Problem: Arrears policy appears applied but access is unchanged
**Symptom:** metadata is flagged but membership remains active.  
**Cause:** policy helper records/flags; it does not directly enforce every access restriction or cancel-at-period-end action.  
**Fix:** follow the admin operational workflow and verify downstream access-policy consumers.

### Problem: Cron endpoint is publicly callable
**Symptom:** request without bearer does not return 401.  
**Cause:** `CRON_SECRET` is unset.  
**Fix:** set and verify the deployment secret and scheduler header before live enablement.

### Problem: Discovered mandate does not appear as a plan
**Symptom:** discovery says matched but member has no agreement.  
**Cause:** expected behaviour: discovery is isolated staging, not import.  
**Fix:** use an approved join/migration path; do not manually promote staging rows without a designed consent and reconciliation process.
