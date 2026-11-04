# BNMS booking block — read-only investigation

## Owner summary

Rachel already has a **confirmed booking** for **Renal sestamibi SPECT/CT study day**, starting **26 November 2026 at 09:00 UTC**. The booking was created **2 November 2026 at 10:55:14 UTC**, records **£168 on account**, and links to **Xero invoice INV-9399**. Review that existing booking/invoice before asking her to purchase again.

The reported “Xero customer lookup unavailable” message means the inspected application received a non-success HTTP response from Xero Contacts. **The underlying provider cause is not established.** This path discards the provider status and Retry-After. It cannot distinguish rate limiting, authorisation refusal, a missing saved contact or other provider/request failures. No verified timestamp or request identifier for the reported failed attempt was available.

## Production evidence and scope

Read-only destination SQL observations were collected **4 November 2026, 08:54–08:56 UTC**, using the existing destination-only connection helper in `scripts/annual-meeting-destination.mjs`. The helper pins REST project `lvmzliemqnieeoruhkik`, SQL project identity/host and port, and verifies TLS using the provider CA. Queries ran inside explicit read-only transactions; related query batches used repeatable-read. No application token helpers or provider calls were executed.

The Supabase management SQL interface denied access. The separately configured, pinned destination SQL connection succeeded. The legacy SOURCE database and generic workspace database were not used.

### Identity and event

- Verified tenant is BNMS.
- Exactly one BNMS member matched Rachel Walker's first and last name.
- Exactly one event across simple and complex events matched “sestamibi”: the simple event named above.
- The existing booking's member ID, attendee email and attendee name all match that member. No email, address or other unnecessary personal details are reproduced here.
- Internal event reference: `1fb90343-a129-4fcf-affd-07db4d572a51`.
- Booking reference: `OOE-1793616913927-517QB`.

This verifies the member/event relationship and existing booking, **not** the identity, time or request details of the screenshot's failed attempt.

### Booking/payment evidence

| Check | Observed result |
|---|---|
| Matching event bookings by member ID, attendee email or purchaser-context member ID | One row, confirmed, created 2 November at 10:55:14.045 UTC |
| Recorded payment method and amount | `account`; total and account amount both £168 |
| Voucher / training-fund amounts | Both zero |
| Stripe payment-intent link on booking | None |
| Xero invoice | INV-9399; invoice ID populated |
| Booking invoice recovery | `complete` |
| Exact booking-group recovery row | Created 10:55:15.671 UTC; complete at 10:55:39.773 UTC on 2 November; invoice present, no payment ID or settlement Stripe intent |
| Member's saved event invoice-address policies, including payment-binding join | None, across all events |
| Group bookings for this event with matching booker email | None |
| Public-ticket member-purchase rows for this event | Zero, event-wide |
| Purchaser context on existing booking | Absent; do not infer a different payer or a recorded card authorisation |

The recovery completion establishes stored invoice-processing completion, not live Xero settlement. No Stripe or Xero account was queried. An absent application payment link/policy is **not proof that no external charge exists**, particularly if a provider write succeeded before local persistence or another checkout path was used. No refund, cancellation or fresh payment is justified by this investigation.

## Failure-path analysis

`api/_lib/eventInvoiceAddressPolicy.js:69–118` verifies the event/member, enabled accounting configuration and a unique selected Xero company. It checks any stored member/company mappings, resolves an access token, checks the selected company again, then performs a direct Contacts GET.

At line 114 a non-OK response produces exactly “Xero customer lookup unavailable”. It does not preserve HTTP status, Retry-After, rate-limit headers or a provider request identifier. `api/event-invoice-address.js:20–21` turns this into the generic application 503 / `EVENT_INVOICE_POLICY_UNAVAILABLE`, without logging a diagnostic event. **An application 503 here does not establish an upstream Xero 503.**

Other failures have different paths/messages: unsuccessful token refresh, a company-change check, ambiguous or inactive customer, JSON-level provider rejection and a transport timeout are not this explicit non-OK response branch. This attribution is based on current source plus the reported text; deployed-source equivalence and an actual historical response were not independently captured.

`client/src/components/booking/EventInvoiceAddressStep.jsx` opens “Choose invoice address” while discovery is loading; the heading does not mean Xero has already established that a new customer needs an address. On error it leaves the promise unresolved and offers an address-check retry. In `PaymentOptions.jsx:1417–1420`, discovery is awaited before the card payment-intent creation flow continues. A failure at this stage blocks that continuation, but does not erase or rule out an earlier completed booking.

The default token resolver in `api/_lib/xero.js:128–224` can refresh and persist tokens. It was deliberately **not executed** in this read-only investigation.

## Selected company and queue correlation

At 08:54:16 UTC:

- Active accounting provider: `xero`; invoice setting true; Xero integration enabled.
- Exactly one BNMS token metadata row selected **British Nuclear Medicine Society**, company `3d57dce6-2205-462f-abf6-9c7cbf00be23`, matching the earlier investigation.
- Stored token expiry: 09:15:07.599 UTC. This does not prove the grant was usable during the failed attempt.
- No alpha/beta immutable member-invoice mappings were found for Rachel. The current member schema has no legacy `xero_contact_id` / `xero_tenant_id` columns, so the inspected current path would perform name/email Contacts discovery rather than use one of those mappings.
- The company queue cooldown timestamp was **08:53:57.412 UTC**, already past at observation.

**That cooldown is not evidence of a past 429.** The queue finish SQL updates cooldown to at least `now()` even when the supplied cooldown is zero. It stores a current boundary, not a historical record of rejected Contacts requests. The direct address lookup does not participate in this queue.

The BNMS queue snapshot contained only GoCardless payment and Stripe member-quote source types: 271 completed GoCardless rows, 219 in review and one running; four completed Stripe member-quote rows. Review reasons were generic preparation/binding/discovery failures. These are different operations and do not establish Rachel's failure cause. Background processing was active, so these counts are a snapshot, not a stable incident ledger.

The earlier report, `reports/bnms-xero-investigation-2026-11-04.md`, establishes stored connection configuration and discusses quota entitlement conditionally. It does not verify the grant-time application, tier or a particular exhausted quota. No developer-tier change or reconnection is recommended from the present evidence.

## Historical evidence limits

- Better Stack source inventory was rechecked: one source, **Onboarding • Real-time flights**, with no production application source available.
- The Vercel connector successfully read project metadata for `vite-migrate-replit-6` and its production deployment reference. Project access is available; historical runtime evidence was not obtained.
- The documented Vercel REST runtime-log endpoint returns a **stream**, not a historical request query. The existing project investigation notes also record that historical CLI/dashboard requests use a different origin from this connector's `api.vercel.com` proxy. A live stream or deployment build log was not misrepresented as historical evidence.
- No screenshot timestamp, timezone, request ID or historical provider status was available. The November 2 booking timestamp and November 4 database observations **must not be substituted for the failure timestamp**.

Confirmed technical failure class: non-OK Contacts response, conditional on the reported message/current source correspondence. Specific cause and approximate incident timing remain unverified.

## Safest next action

1. Ask the BNMS administrator to review the existing confirmed booking and INV-9399, including whether Rachel intended a second place or was attempting to pay an existing invoice. Do not cancel, repay or create another booking automatically.
2. If any card payment was attempted separately, reconcile it read-only in the payment provider against the existing purchase before authorising another payment. This report does not establish live settlement.
3. Obtain the failed attempt's approximate date/time and timezone and a redacted historical Vercel request entry for `/api/event-invoice-address`. Useful fields are timestamp, deployment/request ID and route. The application's generic 503 alone will still not identify Xero's status.
4. If retained logs cannot supply the provider evidence, approve a bounded diagnostic change separately. Capture UTC time, a correlation ID, tenant/event and selected-company identifiers, endpoint **class** (Contacts search/exact lookup, never its name/email query), upstream status, validated Retry-After and allowlisted rate-limit/request headers. Never capture tokens, credentials, full URLs, customer data, addresses or response bodies. Return safe retry guidance while retaining fail-closed identity checks.
5. Only after duplicate-purchase review and explicit approval, capture **one address-discovery request**, stopping before payment. Normal discovery may refresh/persist OAuth tokens, so it is not part of this read-only task. Honour a captured 429's Retry-After; investigate captured 401/403 or other errors on their own evidence rather than guessing or reconnecting automatically.

## Verification and changes

Only this report was authored by the investigation. Existing unrelated working-tree edits were left untouched. No booking, payment, invoice, contact, credential, connection, tenant setting or database record was changed by the investigation; no checkout replay, provider request, token refresh or deployment occurred.

**Completion is blocked:** the completion checkpoint also included accounting changes that were already present when this investigation began: queue integration/provider changes and tests, a reconnection-approval helper/test/migration/script, BNMS recovery-script changes and an accounting-recovery memory addition. Therefore the packaged task diff is **not report-only** and must not be approved as a read-only investigation. These pre-existing changes need separation and their own explicit review; they have not been deleted or reverted without owner approval.

Configured validation ran. `node scripts/run-regression-suite.mjs rolling-memberships` failed in `rollingMembershipCommitment.postgres.test.mjs` on `Date` versus `FrozenDate` strict equality; the other listed suites and safety-boundary checks passed. No unrelated test or financial-workflow code was modified to force completion. Browser verification is not relevant to the investigation report.
